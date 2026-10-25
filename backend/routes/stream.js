const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const { proxyHLS } = require('../services/streamProxy');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { getDb } = require('../db/database');
const { ffmpegAvailable } = require('../services/ffmpegCheck');
const transcoder = require('../services/rtspTranscoder');
const k3iBridge = require('../services/k3iBridge');

const router = express.Router();

// ─── K3I Korlantas bridge ────────────────────────────────────────────────────
// GET /api/stream/k3i/status — is the bridge configured / logged in?
router.get('/k3i/status', authenticate, (req, res) => {
  res.json(k3iBridge.status());
});

// GET /api/stream/k3i/cameras — (admin) raw K3I camera list for inspection
router.get('/k3i/cameras', authenticate, requireRole('admin', 'superadmin'), async (req, res) => {
  if (!k3iBridge.isConfigured()) return res.status(400).json({ error: 'K3I belum dikonfigurasi' });
  try {
    const all = await k3iBridge.getCameras();
    res.json({ count: all.length, sample: all.slice(0, 2) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
router.use('/rtsp', createRateLimiter(60_000, 600, 'Stream rate limit exceeded'));

// GET /api/stream/hls?url=ENCODED_URL
// Proxies HLS playlist (.m3u8) and segments (.ts) through backend to avoid CORS
router.get('/hls', authenticate, proxyHLS);

// GET /api/stream/capabilities — report whether RTSP transcoding is available
router.get('/capabilities', authenticate, (req, res) => {
  res.json({ ffmpeg: ffmpegAvailable(), rtspTranscode: ffmpegAvailable() });
});

// ─── RTSP → HLS live transcode ──────────────────────────────────────────────
// GET /api/stream/rtsp/:cameraId/index.m3u8  → starts/reuses ffmpeg, serves playlist
// GET /api/stream/rtsp/:cameraId/:segment.ts → serves generated segments
router.get('/rtsp/:cameraId/:file', authenticate, async (req, res) => {
  const { cameraId, file } = req.params;

  // Only allow the expected generated filenames (no traversal).
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
  if ((camera.link_type || '').toUpperCase() !== 'RTSP') {
    return res.status(400).json({ error: 'Camera is not RTSP' });
  }
  if (!/^rtsp:\/\//i.test(camera.link)) {
    return res.status(400).json({ error: 'Invalid RTSP link' });
  }

  // Start (or reuse) the transcode session and wait for the first playlist.
  if (file === 'index.m3u8') {
    transcoder.startSession(cameraId, camera.link);
    const ready = await transcoder.waitForPlaylist(cameraId);
    if (!ready) {
      transcoder.stopSession(cameraId);
      return res.status(504).json({ error: 'Stream RTSP gagal dimulai (timeout)' });
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

// GET /api/stream/info/:cameraId
// Returns the proxied stream URL for a camera
router.get('/info/:cameraId', authenticate, (req, res) => {
  const camera = getDb().prepare(`
    SELECT id, name, link, link_type, access_class, health_status
    FROM cameras WHERE id = ?
  `).get(req.params.cameraId);

  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const host = `${req.protocol}://${req.get('host')}`;
  const linkType = (camera.link_type || '').toUpperCase();

  let streamUrl = null;
  let playerType = 'hls';

  if (linkType === 'M3U8' || linkType === 'HLS') {
    streamUrl = `${host}/api/stream/hls?url=${encodeURIComponent(camera.link)}`;
    playerType = 'hls';
  } else if (linkType === 'MJPEG') {
    streamUrl = `${host}/api/stream/mjpeg?url=${encodeURIComponent(camera.link)}`;
    playerType = 'mjpeg';
  } else if (linkType === 'WSS') {
    streamUrl = camera.link;
    playerType = 'wss';
  } else if (linkType === 'RTSP') {
    if (ffmpegAvailable()) {
      // Transcode RTSP → HLS live via FFmpeg
      streamUrl = `${host}/api/stream/rtsp/${encodeURIComponent(camera.id)}/index.m3u8`;
      playerType = 'hls';
    } else {
      streamUrl = null;
      playerType = 'rtsp';
    }
  } else if (linkType === 'HTTP' || linkType === 'HTTPS') {
    // Try to proxy as generic stream
    streamUrl = `${host}/api/stream/hls?url=${encodeURIComponent(camera.link)}`;
    playerType = 'hls';
  }

  res.json({
    cameraId: camera.id,
    name: camera.name,
    streamUrl,
    linkType: camera.link_type,
    playerType,
    health: camera.health_status,
    directUrl: camera.link,
    accessClass: camera.access_class,
  });
});

module.exports = router;
