/**
 * RTSP → HLS transcoder.
 * Spawns FFmpeg on demand to convert an RTSP stream into browser-playable HLS
 * (fragmented .m3u8 + .ts segments) written to a per-camera temp folder.
 * Sessions are reused across viewers and auto-stopped after an idle timeout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');

const OUTPUT_ROOT = path.join(os.tmpdir(), 'p4us-hls');
const IDLE_TIMEOUT_MS = 60_000;   // stop ffmpeg if no playlist hit for 60s
const START_TIMEOUT_MS = 12_000;  // give ffmpeg this long to produce a playlist

// cameraId -> { proc, dir, lastAccess, ready, startedAt }
const sessions = new Map();

// Path ffprobe diturunkan dari ffmpegPath (...\ffmpeg(.exe) → ...\ffprobe(.exe)).
const ffprobePath = config.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

// Cache codec per URL input (codec kamera jarang berubah). Hanya hasil POSITIF
// yang di-cache; hasil null (kamera offline saat probe) dibiarkan agar dicoba
// lagi nanti.
const codecCache = new Map();

// pix_fmt yang bisa didekode <video> browser via stream-copy (8-bit 4:2:0).
// yuv422p/yuv444p/10-bit (yuv420p10le dll) TIDAK → harus re-encode.
const BROWSER_SAFE_PIXFMT = /^(yuv420p|yuvj420p)$/;

/**
 * Probe codec + pix_fmt video stream pertama via ffprobe.
 * @returns {{codec:string|null, pixFmt:string|null, playable:boolean}}
 *   playable = true hanya bila H.264 DAN pix_fmt aman-browser (bisa di-copy).
 *   Bila probe gagal (kamera offline), codec=null & playable=false → pemanggil
 *   sebaiknya re-encode (lebih aman daripada copy yang berisiko hitam).
 *
 * PENTING untuk layar hitam: banyak kamera IP (Hikvision/Dahua) memakai H.265
 * (HEVC) — atau H.264 profil tinggi (4:2:2 / 10-bit) — yang TIDAK bisa didekode
 * <video>. Bila di-"stream copy" ke HLS, playlist valid terbentuk (seolah online)
 * tapi gambar HITAM. Dengan tahu codec+pix_fmt, pemanggil memaksa re-encode.
 */
function probeVideoCodec(inputUrl, { rtsp = true, timeoutMs = 6000 } = {}) {
  if (codecCache.has(inputUrl)) return codecCache.get(inputUrl);

  const args = [];
  if (rtsp) args.push('-rtsp_transport', 'tcp', '-timeout', String(timeoutMs * 1000));
  args.push('-i', inputUrl, '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'default=nw=1:nk=1', '-v', 'error');

  let codec = null, pixFmt = null;
  try {
    const r = spawnSync(ffprobePath, args, { timeout: timeoutMs + 3000, encoding: 'utf8' });
    const lines = String(r.stdout || '').trim().toLowerCase().split('\n').map((s) => s.trim()).filter(Boolean);
    // Urutan default: codec_name lalu pix_fmt.
    const raw = lines[0] || '';
    if (/h264|avc/.test(raw)) codec = 'h264';
    else if (/hevc|h265/.test(raw)) codec = 'h265';
    else if (raw) codec = raw;
    if (lines[1]) pixFmt = lines[1];
  } catch { /* ffprobe tak ada / timeout → null */ }

  const playable = codec === 'h264' && !!pixFmt && BROWSER_SAFE_PIXFMT.test(pixFmt);
  const result = { codec, pixFmt, playable };
  if (codec) codecCache.set(inputUrl, result); // cache hanya hasil positif
  return result;
}

function ensureRoot() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function sessionDir(cameraId) {
  return path.join(OUTPUT_ROOT, safeId(cameraId));
}

// Build the FFmpeg argument list for a transcode session.
function buildArgs(inputUrl, dir, { rtsp, encode }) {
  const args = [];
  // -timeout 6s: jangan menggantung lama pada kamera yang sulit dijangkau.
  if (rtsp) args.push('-rtsp_transport', 'tcp', '-timeout', '6000000');
  args.push('-i', inputUrl, '-an');
  if (encode) {
    // Re-encode to H.264 (e.g. H.265 source that browsers can't decode).
    // -pix_fmt yuv420p: sebagian kamera keluarkan yuvj420p/yuv422 yang bikin
    // sebagian browser gagal render (layar hitam) — paksa ke 8-bit 4:2:0.
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-g', '50');
  } else {
    args.push('-c:v', 'copy'); // stream copy = light CPU, try first for RTSP
  }
  args.push(
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
    path.join(dir, 'index.m3u8'),
  );
  return args;
}

/**
 * Start (or reuse) a transcode session.
 * @param opts { rtsp?: boolean, encode?: boolean } — rtsp input / force H.264 re-encode.
 */
function startSession(cameraId, inputUrl, opts = {}) {
  const rtsp = opts.rtsp !== false; // default RTSP for backward compatibility
  const encode = !!opts.encode;

  const existing = sessions.get(cameraId);
  if (existing) {
    existing.lastAccess = Date.now();
    return { playlist: path.join(existing.dir, 'index.m3u8'), dir: existing.dir, reused: true };
  }

  ensureRoot();
  const dir = sessionDir(cameraId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn(config.ffmpegPath, buildArgs(inputUrl, dir, { rtsp, encode }),
    { stdio: ['ignore', 'ignore', 'pipe'] });

  const session = { proc, dir, lastAccess: Date.now(), ready: false, startedAt: Date.now(), copyFailed: encode, inputUrl, rtsp };
  sessions.set(cameraId, session);

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    // If "copy" couldn't be muxed into HLS, retry once with re-encode.
    if (!session.copyFailed && /codec.*not.*(supported|compatible)|Could not find codec|Only VP8/i.test(stderrTail)) {
      session.copyFailed = true;
      restartWithEncode(cameraId);
    }
  });

  proc.on('exit', () => {
    if (sessions.get(cameraId)?.proc === proc && !session.copyFailed) {
      sessions.delete(cameraId);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  return { playlist: path.join(dir, 'index.m3u8'), dir, reused: false };
}

function restartWithEncode(cameraId) {
  const session = sessions.get(cameraId);
  if (!session) return;
  try { session.proc.kill('SIGKILL'); } catch {}

  const proc = spawn(config.ffmpegPath, buildArgs(session.inputUrl, session.dir, { rtsp: session.rtsp, encode: true }),
    { stdio: ['ignore', 'ignore', 'ignore'] });
  session.proc = proc;
  session.lastAccess = Date.now();
  proc.on('exit', () => {
    if (sessions.get(cameraId)?.proc === proc) {
      sessions.delete(cameraId);
      fs.rmSync(session.dir, { recursive: true, force: true });
    }
  });
}

function touch(cameraId) {
  const s = sessions.get(cameraId);
  if (s) s.lastAccess = Date.now();
}

function stopSession(cameraId) {
  const s = sessions.get(cameraId);
  if (!s) return;
  try { s.proc.kill('SIGKILL'); } catch {}
  sessions.delete(cameraId);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

/** Wait until the playlist file exists (ffmpeg produced first segments). */
function waitForPlaylist(cameraId) {
  return new Promise((resolve) => {
    const s = sessions.get(cameraId);
    if (!s) return resolve(false);
    const playlist = path.join(s.dir, 'index.m3u8');
    const deadline = Date.now() + START_TIMEOUT_MS;
    const check = () => {
      if (fs.existsSync(playlist)) { s.ready = true; return resolve(true); }
      if (!sessions.has(cameraId) || Date.now() > deadline) return resolve(false);
      setTimeout(check, 400);
    };
    check();
  });
}

// Idle sweeper: stop sessions nobody is watching.
setInterval(() => {
  const now = Date.now();
  for (const [cameraId, s] of sessions) {
    if (now - s.lastAccess > IDLE_TIMEOUT_MS) stopSession(cameraId);
  }
}, 15_000).unref();

// Kill all ffmpeg children on shutdown.
function shutdown() {
  for (const [, s] of sessions) { try { s.proc.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true }); } catch {}
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

module.exports = { startSession, stopSession, touch, waitForPlaylist, sessionDir, probeVideoCodec };
