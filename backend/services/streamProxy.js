/**
 * HLS Stream Proxy
 * Fetches M3U8 playlists and .ts segments from source CCTV servers,
 * rewrites URLs to route through this proxy, and forwards to client.
 * This avoids browser CORS restrictions and hides source credentials.
 */
const axios = require('axios');
const k3iBridge = require('./k3iBridge');

const HTTP_TIMEOUT = 8000;
const SEGMENT_TIMEOUT = 15000;

// Simple in-memory cache for master playlists (avoids duplicate fetch within 2s)
const playlistCache = new Map();
const CACHE_TTL = 2000;

function getCached(key) {
  const entry = playlistCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { playlistCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  playlistCache.set(key, { data, ts: Date.now() });
}

function buildProxyUrl(originalUrl, proxyBase) {
  return `${proxyBase}?url=${encodeURIComponent(originalUrl)}`;
}

function rewriteM3U8(content, originalBaseUrl, proxyBase) {
  const base = new URL(originalBaseUrl);
  const baseDir = base.href.substring(0, base.href.lastIndexOf('/') + 1);

  return content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    // Resolve relative and protocol-relative URLs
    let absUrl;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      absUrl = trimmed;
    } else if (trimmed.startsWith('//')) {
      absUrl = `${base.protocol}${trimmed}`;
    } else {
      try { absUrl = new URL(trimmed, baseDir).href; } catch { return line; }
    }
    return buildProxyUrl(absUrl, proxyBase);
  }).join('\n');
}

async function proxyHLS(req, res) {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'url parameter required' });

  let targetUrl;
  try { targetUrl = decodeURIComponent(rawUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'Only http/https URLs are supported' });
  }

  // SSRF guard: block private/loopback addresses
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) || host === '0.0.0.0'
    ) {
      return res.status(400).json({ error: 'Private/loopback addresses not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const isSegment = /\.ts(\?|$)/i.test(targetUrl) || /\/media_.*\.ts/i.test(targetUrl);
  const cached = !isSegment && getCached(targetUrl);

  if (cached) {
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.send(cached);
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (compatible; P4US-CCTV/1.0)',
      'Referer': parsedTarget.origin,
    };

    // K3I Korlantas streams: send the operator session token + portal Referer
    // so the VMS accepts the request when it enforces an authenticated session.
    const k3i = k3iBridge.isK3iHost(parsedTarget.hostname);
    if (k3i) Object.assign(reqHeaders, await k3iBridge.getStreamHeaders());

    const upstream = await axios.get(targetUrl, {
      timeout: isSegment ? SEGMENT_TIMEOUT : HTTP_TIMEOUT,
      responseType: isSegment ? 'arraybuffer' : 'text',
      headers: reqHeaders,
      validateStatus: (s) => s < 500,
    });

    // On an auth failure from a K3I host, drop the cached token so the next
    // attempt re-logs in.
    if (upstream.status === 401 && k3i) k3iBridge.invalidate();

    if (upstream.status !== 200) {
      return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    }

    if (isSegment) {
      res.set({
        'Content-Type': upstream.headers['content-type'] || 'video/mp2t',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.send(Buffer.from(upstream.data));
    }

    // Rewrite M3U8 playlist so all URLs pass through this proxy
    const proxyBase = `${req.protocol}://${req.get('host')}/api/stream/hls`;
    const rewritten = rewriteM3U8(upstream.data, targetUrl, proxyBase);

    setCache(targetUrl, rewritten);
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(rewritten);

  } catch (err) {
    if (err.code === 'ECONNABORTED') return res.status(504).json({ error: 'Upstream timeout' });
    if (err.code === 'ENOTFOUND') return res.status(502).json({ error: 'Upstream host not found' });
    return res.status(502).json({ error: 'Upstream error' });
  }
}

async function checkStreamHealth(url, linkType) {
  if (!url) return { status: 'UNKNOWN', latencyMs: null };

  const start = Date.now();
  try {
    if (linkType === 'M3U8' || linkType === 'HLS') {
      const headers = { 'User-Agent': 'P4US-CCTV-HealthCheck/1.0' };
      try {
        const host = new URL(url).hostname;
        if (k3iBridge.isK3iHost(host)) Object.assign(headers, await k3iBridge.getStreamHeaders());
      } catch {}
      const res = await axios.get(url, {
        timeout: 5000,
        headers,
        validateStatus: (s) => s < 500,
      });
      const latencyMs = Date.now() - start;
      if (res.status === 200 && res.data?.includes('#EXTM3U')) {
        return { status: latencyMs < 2000 ? 'LIVE' : 'SLOW', latencyMs };
      }
      return { status: 'DEAD', latencyMs };
    }

    if (linkType === 'WSS') {
      // Cannot easily check WSS from Node without ws library; mark as UNKNOWN
      return { status: 'UNKNOWN', latencyMs: null };
    }

    return { status: 'UNKNOWN', latencyMs: null };
  } catch {
    return { status: 'DEAD', latencyMs: Date.now() - start };
  }
}

module.exports = { proxyHLS, checkStreamHealth };
