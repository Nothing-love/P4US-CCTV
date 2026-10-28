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

// ── Cookie jar sesi (per-host) ──────────────────────────────────────────────
// Sebagian sumber (mis. jmlive.jasamarga.com di balik Varnish) memakai cookie
// sesi: request pertama balas KOSONG + Set-Cookie, konten baru keluar pada
// request berikutnya yang menyertakan cookie itu. Browser melakukannya otomatis;
// proxy kita harus meniru agar streamnya benar-benar keluar gambar.
const cookieJar = new Map();           // host -> { cookie, ts }
// Cookie sesi dipakai ulang beberapa JAM agar tak sering ambil-ulang. Bila
// server menolaknya (balas kosong), fetchUpstream otomatis membuang & ambil
// sesi baru. Ini cookie ANONIM (bukan login berkredensial), jadi tidak ada
// risiko akun "terkunci" — berbeda dari login K3I.
const COOKIE_TTL = 3 * 60 * 60_000;    // 3 jam
function getHostCookie(host) {
  const e = cookieJar.get(host);
  if (e && Date.now() - e.ts < COOKIE_TTL) return e.cookie;
  if (e) cookieJar.delete(host);
  return null;
}
function storeHostCookie(host, setCookie) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = arr.map((s) => String(s).split(';')[0]).join('; ');
  if (cookie) cookieJar.set(host, { cookie, ts: Date.now() });
}

// GET upstream dengan penanganan cookie sesi OTOMATIS + "warm-up". Sumber ber-
// sesi (mis. jmlive) balas KOSONG di request pertama + Set-Cookie; request
// berikutnya dengan cookie itu baru keluar isinya. Fungsi ini menirunya, dan
// bila cookie lama ternyata basi (balas kosong) ia buang lalu ambil sesi baru.
async function fetchUpstream(url, { headers = {}, responseType = 'text', timeout = HTTP_TIMEOUT } = {}) {
  const host = new URL(url).hostname;
  const isText = responseType !== 'arraybuffer';
  const get = (cookie) => axios.get(url, {
    timeout, responseType, maxRedirects: 3, validateStatus: (s) => s < 500,
    headers: cookie ? { ...headers, Cookie: cookie } : { ...headers },
  });
  const empty = (r) => isText && (!r.data || (typeof r.data === 'string' && r.data.trim() === ''));

  let res = await get(getHostCookie(host));
  storeHostCookie(host, res.headers['set-cookie']);
  if (empty(res)) {
    cookieJar.delete(host);           // buang cookie basi
    res = await get(null);            // request bersih → picu Set-Cookie baru
    storeHostCookie(host, res.headers['set-cookie']);
    const fresh = getHostCookie(host);
    if (empty(res) && fresh) {        // ulangi sekali dengan cookie baru
      res = await get(fresh);
      storeHostCookie(host, res.headers['set-cookie']);
    }
  }
  return res;
}

// Ambil URL varian pertama dari master playlist (baris setelah #EXT-X-STREAM-INF).
function firstVariant(body, baseUrl) {
  const lines = String(body).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/#EXT-X-STREAM-INF/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t && !t.startsWith('#')) {
          try { return new URL(t, baseUrl).href; } catch { return null; }
        }
      }
    }
  }
  return null;
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

    const upstream = await fetchUpstream(targetUrl, {
      headers: reqHeaders,
      responseType: isSegment ? 'arraybuffer' : 'text',
      timeout: isSegment ? SEGMENT_TIMEOUT : HTTP_TIMEOUT,
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
  if (linkType !== 'M3U8' && linkType !== 'HLS') {
    return { status: 'UNKNOWN', latencyMs: null }; // WSS/RTSP/etc not probed here
  }

  const headers = { 'User-Agent': 'P4US-CCTV-HealthCheck/1.0' };
  try {
    const host = new URL(url).hostname;
    if (k3iBridge.isK3iHost(host)) {
      // Pemeriksaan kesehatan TIDAK boleh memicu login K3I (cegah akun terkunci
      // dari sisi portal). Tanpa token aktif → lewati probe dan biarkan status
      // apa adanya (UNKNOWN), jangan ditandai DEAD. Status kamera K3I diperbarui
      // saat sync manual atau saat user benar-benar memutar streamnya.
      const h = await k3iBridge.getStreamHeaders({ allowLogin: false });
      if (!h.Authorization) return { status: 'UNKNOWN', latencyMs: null };
      Object.assign(headers, h);
    }
  } catch {}

  // Timeout generous (8s) seperti kesabaran browser; latency <4s = LIVE.
  // Hasil tiap percobaan:
  //   'live'      → 200 + playlist terbaca (#EXTM3U)
  //   'reachable' → host menjawab 2xx/3xx tapi playlist tak bisa diverifikasi
  //                 (mis. jmlive.jasamarga.com balas 200 kosong karena butuh
  //                 cookie/sesi). Host JELAS hidup → jangan divonis mati.
  //   'fail'      → 4xx, error koneksi, atau timeout (kegagalan nyata)
  // "online" sejati = playlist punya SEGMEN nyata (#EXTINF). Kalau master
  // playlist, ikuti varian pertama lalu cek segmennya. Pakai cookie sesi.
  async function attempt() {
    const start = Date.now();
    try {
      const res = await fetchUpstream(url, { headers, responseType: 'text', timeout: 8000 });
      const latencyMs = Date.now() - start;
      const body = typeof res.data === 'string' ? res.data : '';
      if (res.status >= 200 && res.status < 300 && body.includes('#EXTM3U')) {
        if (/#EXTINF/i.test(body)) {
          return { outcome: 'live', status: latencyMs < 4000 ? 'LIVE' : 'SLOW', latencyMs };
        }
        // Master playlist → verifikasi varian pertama benar punya segmen.
        const variant = firstVariant(body, url);
        if (variant) {
          try {
            const r2 = await fetchUpstream(variant, { headers, responseType: 'text', timeout: 8000 });
            const b2 = typeof r2.data === 'string' ? r2.data : '';
            if (r2.status >= 200 && r2.status < 300 && /#EXTINF/i.test(b2)) {
              const lat = Date.now() - start;
              return { outcome: 'live', status: lat < 4000 ? 'LIVE' : 'SLOW', latencyMs: lat };
            }
          } catch {}
        }
        // Punya #EXTM3U tapi tak ada segmen terverifikasi → terjangkau, bukan LIVE.
        return { outcome: 'reachable', latencyMs };
      }
      if (res.status >= 200 && res.status < 400) {
        return { outcome: 'reachable', latencyMs };
      }
      return { outcome: 'fail', latencyMs };
    } catch {
      return { outcome: 'fail', latencyMs: Date.now() - start };
    }
  }

  // Host yang menjawab 2xx/3xx dianggap TERJANGKAU → status akhir ikut katalog
  // (k3i_active/access_class), bukan DEAD. DEAD hanya untuk kegagalan nyata.
  let r = await attempt();
  if (r.outcome === 'live')      return { status: r.status, latencyMs: r.latencyMs };
  if (r.outcome === 'reachable') return { status: 'UNKNOWN', latencyMs: r.latencyMs };
  // Coba sekali lagi sebelum menyatakan DEAD (hindari false-offline transien).
  await new Promise((res) => setTimeout(res, 800));
  r = await attempt();
  if (r.outcome === 'live')      return { status: r.status, latencyMs: r.latencyMs };
  if (r.outcome === 'reachable') return { status: 'UNKNOWN', latencyMs: r.latencyMs };
  return { status: 'DEAD', latencyMs: r.latencyMs };
}

module.exports = { proxyHLS, checkStreamHealth };
