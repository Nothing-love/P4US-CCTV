const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { authenticate, authenticateMedia, requireRole } = require('../middleware/authMiddleware');
const { proxyHLS } = require('../services/streamProxy');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { getDb } = require('../db/database');
const { ffmpegAvailable } = require('../services/ffmpegCheck');
const transcoder = require('../services/rtspTranscoder');
const k3iBridge = require('../services/k3iBridge');
const jmliveResolver = require('../services/jmliveResolver');

const router = express.Router();

// Hosts that send CORS "*" so the browser can fetch HLS directly (no proxy hop
// = minimal buffering). Bali Tower is one such source.
function isCorsOpenHost(host) {
  return /(^|\.)balitower\.co\.id$/i.test(host || '');
}

// Detect the master-playlist video codec (cached). 'h264' plays natively in the
// browser; 'h265' (HEVC) must be transcoded.
const codecCache = new Map();
async function detectCodec(link) {
  if (codecCache.has(link)) return codecCache.get(link);
  let codec = 'unknown';
  try {
    const r = await axios.get(link, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; P4US-CCTV/1.0)' },
      validateStatus: (s) => s < 500,
    });
    const body = String(r.data || '');
    if (/avc1/i.test(body)) codec = 'h264';          // prefer H.264 if present
    else if (/hvc1|hev1/i.test(body)) codec = 'h265';
  } catch { /* leave unknown */ }
  codecCache.set(link, codec);
  return codec;
}

// ─── K3I Korlantas bridge ────────────────────────────────────────────────────
// POST /api/stream/k3i/sync — (admin) pull the live camera list from K3I and
// refresh real GPS coordinates, live status, and stream links in the DB.
router.post('/k3i/sync', authenticate, requireRole('admin', 'superadmin'), async (req, res) => {
  if (!k3iBridge.isConfigured()) {
    return res.status(400).json({ error: 'Kredensial K3I belum dikonfigurasi di .env' });
  }
  try {
    // Manual trigger: clear any login backoff so the user can force a retry.
    k3iBridge.resetCooldown();
    const result = await require('../services/k3iSync').syncCoordinates();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Sync K3I gagal: ${err.message}` });
  }
});

// POST /api/stream/k3i/token — (admin) use a token copied from a logged-in K3I
// browser (localStorage "tbp-token") and immediately sync coordinates.
router.post('/k3i/token', authenticate, requireRole('admin', 'superadmin'), async (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token || token.length < 20) {
    return res.status(400).json({ error: 'Token tidak valid' });
  }
  try {
    k3iBridge.setToken(token);
    const result = await require('../services/k3iSync').syncCoordinates();
    res.json(result);
  } catch (err) {
    k3iBridge.invalidate();
    res.status(502).json({ error: `Sync gagal (token mungkin kedaluwarsa): ${err.message}` });
  }
});

// Lightweight rate limit for stream proxy (per IP)
router.use('/hls', createRateLimiter(60_000, 300, 'Stream proxy rate limit exceeded'));
router.use('/transcode', createRateLimiter(60_000, 600, 'Stream rate limit exceeded'));

// GET /api/stream/hls?url=ENCODED_URL
// Proxies HLS playlist (.m3u8) and segments (.ts) through backend to avoid CORS
router.get('/hls', authenticate, proxyHLS);

// ─── Live transcode → HLS (H.264) ───────────────────────────────────────────
// Handles both RTSP sources and HLS sources whose codec the browser can't
// decode (e.g. Bali Tower H.265). FFmpeg outputs browser-friendly H.264 HLS.
// GET /api/stream/transcode/:cameraId/index.m3u8   → playlist
// GET /api/stream/transcode/:cameraId/:segment.ts  → segment
router.get('/transcode/:cameraId/:file', authenticate, async (req, res) => {
  const { cameraId, file } = req.params;

  if (!/^(index\.m3u8|seg_\d{3}\.ts)$/.test(file)) {
    return res.status(400).json({ error: 'Invalid file' });
  }
  if (!ffmpegAvailable()) {
    return res.status(503).json({ error: 'FFmpeg tidak terpasang di server' });
  }

  const camera = getDb().prepare(
    'SELECT id, link, link_type FROM cameras WHERE id = ?'
  ).get(cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const lt = (camera.link_type || '').toUpperCase();
  const isRtsp = lt === 'RTSP' && /^rtsp:\/\//i.test(camera.link);
  const isHls = (lt === 'M3U8' || lt === 'HLS') && /^https?:\/\//i.test(camera.link);
  if (!isRtsp && !isHls) {
    return res.status(400).json({ error: 'Sumber tidak bisa di-transcode' });
  }

  if (file === 'index.m3u8') {
    // RTSP: try stream-copy first. HLS here = codec browser can't play → re-encode.
    transcoder.startSession(cameraId, camera.link, { rtsp: isRtsp, encode: isHls });
    const ready = await transcoder.waitForPlaylist(cameraId);
    if (!ready) {
      transcoder.stopSession(cameraId);
      return res.status(504).json({ error: 'Stream gagal dimulai (timeout)' });
    }
  } else {
    transcoder.touch(cameraId);
  }

  const dir = transcoder.sessionDir(cameraId);
  const target = path.join(dir, file);
  if (!target.startsWith(dir) || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Segment not ready' });
  }

  res.set({
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(target).pipe(res);
});

// GET /api/stream/mjpeg?url=ENCODED_URL
// Pipes MJPEG multipart stream through backend (adds auth header, avoids CORS)
router.get('/mjpeg', authenticate, async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'url parameter required' });

  let targetUrl;
  try { targetUrl = decodeURIComponent(rawUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ error: 'Only http/https URLs allowed' });

  // SSRF guard
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) || host === '0.0.0.0'
    ) return res.status(400).json({ error: 'Private/loopback addresses not allowed' });
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const axios = require('axios');
  try {
    const upstream = await axios.get(targetUrl, {
      timeout: 10000,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; P4US-CCTV/1.0)' },
    });
    res.set({
      'Content-Type': upstream.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    upstream.data.pipe(res);
    upstream.data.on('error', () => res.end());
  } catch {
    res.status(502).json({ error: 'Upstream error' });
  }
});

// GET /api/stream/still?url=ENCODED — proxy gambar JPEG (kamera tipe 'still').
// Menambah Referer agar lolos hotlink-protection & disajikan dari origin sendiri
// (lolos CSP img-src 'self'). Dipanggil berulang oleh klien (cache-bust).
router.get('/still', authenticateMedia, async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'url parameter required' });
  let targetUrl;
  try { targetUrl = decodeURIComponent(rawUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ error: 'Only http/https URLs allowed' });

  let parsed;
  try {
    parsed = new URL(targetUrl);
    const h = parsed.hostname.toLowerCase();
    if (
      h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h === '0.0.0.0'
    ) return res.status(400).json({ error: 'Private/loopback addresses not allowed' });
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const upstream = await axios.get(targetUrl, {
      timeout: 10000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; P4US-CCTV/1.0)', Referer: `${parsed.origin}/` },
      validateStatus: (s) => s < 500,
    });
    if (upstream.status !== 200) return res.status(upstream.status).end();
    res.set({
      'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(Buffer.from(upstream.data));
  } catch {
    res.status(502).json({ error: 'Upstream error' });
  }
});

// Menentukan cara memutar satu link (dipakai untuk link primer DAN backup).
async function resolveLink(base, camId, link, linkType, kind, refreshSec, camHost) {
  const lt = (linkType || '').toUpperCase();
  const k = (kind || 'stream').toLowerCase();
  const transcodeUrl = `${base}/api/stream/transcode/${encodeURIComponent(camId)}/index.m3u8`;

  if (k === 'still' || lt === 'STILL') {
    return { streamUrl: `${base}/api/stream/still?url=${encodeURIComponent(link)}`, playerType: 'still', direct: false, refreshSec: refreshSec || 15 };
  }
  if (k === 'frame' || k === 'youtube' || lt === 'FRAME' || lt === 'YOUTUBE') {
    return { streamUrl: link, playerType: 'frame', direct: false, refreshSec: null };
  }
  if (lt === 'M3U8' || lt === 'HLS') {
    // Deteksi codec untuk SEMUA host: H.265/HEVC tak bisa didekode browser →
    // transcode via FFmpeg bila ada, agar benar-benar keluar gambar.
    const codec = await detectCodec(link);
    if (codec === 'h265') {
      if (ffmpegAvailable()) return { streamUrl: transcodeUrl, playerType: 'hls', direct: false };
      return { streamUrl: null, playerType: 'rtsp', direct: false };   // tak bisa diputar tanpa FFmpeg
    }
    if (isCorsOpenHost(camHost)) return { streamUrl: link, playerType: 'hls', direct: true };
    return { streamUrl: `${base}/api/stream/hls?url=${encodeURIComponent(link)}`, playerType: 'hls', direct: false };
  }
  if (lt === 'MJPEG') return { streamUrl: `${base}/api/stream/mjpeg?url=${encodeURIComponent(link)}`, playerType: 'mjpeg', direct: false };
  if (lt === 'WSS') return { streamUrl: link, playerType: 'wss', direct: false };
  if (lt === 'RTSP') {
    if (ffmpegAvailable()) return { streamUrl: transcodeUrl, playerType: 'hls', direct: false };
    return { streamUrl: null, playerType: 'rtsp', direct: false };
  }
  if (lt === 'HTTP' || lt === 'HTTPS') return { streamUrl: `${base}/api/stream/hls?url=${encodeURIComponent(link)}`, playerType: 'hls', direct: false };
  return { streamUrl: null, playerType: 'hls', direct: false };
}

function backupKind(bt) {
  const t = (bt || '').toUpperCase();
  if (t === 'STILL') return 'still';
  if (t === 'FRAME' || t === 'YOUTUBE') return 'frame';
  return 'stream';
}

// GET /api/stream/info/:cameraId — resolves how a camera should be played
// (primer + backup untuk failover).
router.get('/info/:cameraId', authenticate, async (req, res) => {
  let camera = getDb().prepare(`
    SELECT id, name, link, link_type, host, access_class, health_status,
           backup_link, backup_link_type, endpoint_kind, refresh_sec, jm_ruas
    FROM cameras WHERE id = ?
  `).get(req.params.cameraId);

  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  // Jmlive: UUID berputar — ambil URL HLS terkini via resolver sebelum membangun respons.
  if (camera.host === 'jmlive.jasamarga.com' && camera.jm_ruas) {
    const freshHls = await jmliveResolver.resolveJmlive(camera.jm_ruas, camera.name);
    if (freshHls) camera = { ...camera, link: freshHls };
  }

  const base = `${req.protocol}://${req.get('host')}`;
  const primary = await resolveLink(base, camera.id, camera.link, camera.link_type,
    camera.endpoint_kind, camera.refresh_sec, camera.host);

  let backup = null;
  if (camera.backup_link) {
    let bHost = camera.host;
    try { bHost = new URL(camera.backup_link).hostname; } catch {}
    const b = await resolveLink(base, camera.id + '_bk', camera.backup_link,
      camera.backup_link_type || camera.link_type, backupKind(camera.backup_link_type),
      camera.refresh_sec, bHost);
    backup = {
      streamUrl: b.streamUrl, playerType: b.playerType, direct: b.direct,
      refreshSec: b.refreshSec, linkType: camera.backup_link_type || camera.link_type,
      directUrl: camera.backup_link,
    };
  }

  res.json({
    cameraId: camera.id,
    name: camera.name,
    streamUrl: primary.streamUrl,
    playerType: primary.playerType,
    direct: primary.direct,
    refreshSec: primary.refreshSec,
    endpointKind: camera.endpoint_kind,
    linkType: camera.link_type,
    directUrl: camera.link,
    accessClass: camera.access_class,
    health: camera.health_status,
    backup,
  });
});

module.exports = router;
