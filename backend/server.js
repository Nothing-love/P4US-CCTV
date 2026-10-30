require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { initDatabase } = require('./db/database');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { startHealthChecker } = require('./services/healthChecker');
const authRoutes = require('./routes/auth');
const cameraRoutes = require('./routes/cameras');
const streamRoutes = require('./routes/stream');
const recordingRoutes = require('./routes/recordings');
const ptzRoutes = require('./routes/ptz');

const app = express();

// ─── Security headers ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", "'unsafe-inline'",
        'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
      ],
      styleSrc: [
        "'self'", "'unsafe-inline'",
        'fonts.googleapis.com', 'cdnjs.cloudflare.com',
        'unpkg.com',
      ],
      imgSrc: [
        "'self'", 'data:', 'blob:',
        '*.openstreetmap.org', '*.tile.openstreetmap.org',
        '*.basemaps.cartocdn.com', '*.cartocdn.com',
        '*.google.com', 'mt0.google.com', 'mt1.google.com', 'mt2.google.com', 'mt3.google.com',
      ],
      mediaSrc: [
        "'self'", 'blob:', '*.k3i-korlantas.id', '*.jasamarga.com', '*.go.id',
        'https://*.balitower.co.id:*',
      ],
      connectSrc: [
        "'self'", 'blob:', 'data:',
        '*.k3i-korlantas.id', '*.jasamarga.com', '*.go.id',
        'https://*.balitower.co.id:*',
        '*.basemaps.cartocdn.com', '*.cartocdn.com',
        '*.google.com', 'fonts.openmaptiles.org',
        'wss:', 'ws:',
      ],
      fontSrc: ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      // Kamera tipe "frame"/YouTube ditampilkan via <iframe> ke halaman embed
      // resmi pemilik kamera. Izinkan host-host embed tsb di frame-src.
      frameSrc: [
        "'self'",
        'transcode.baliprov.go.id', 'cctv.dpuprkotang.info', 'rtsp.me',
        'www.youtube-nocookie.com', 'youtube-nocookie.com',
        '*.go.id', '*.gov.my',
      ],
      // Server berjalan di HTTP (tanpa TLS) di belakang IP publik. Tanpa baris
      // ini, Helmet menambahkan "upgrade-insecure-requests" yang memaksa browser
      // mengubah semua aset http:// menjadi https:// → gagal dimuat (CSS/logo/JS
      // hilang). Set null untuk mematikannya. Kalau nanti dipasang HTTPS/TLS,
      // baris ini boleh dihapus agar upgrade otomatis aktif lagi.
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: config.allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────
app.use('/api/auth', createRateLimiter(15 * 60_000, 30, 'Too many auth requests'));
// Limiter global /api TIDAK berlaku untuk endpoint media streaming (hls/
// transcode/still/mjpeg): tiap kamera HLS menembak playlist+segmen tiap
// beberapa detik, jadi 8+ kamera mudah menembus 200/mnt → 429 "Too many
// requests" → stream mati tiap beberapa menit. Media punya limiter longgar
// sendiri; endpoint /api lain (auth, daftar kamera, slot) tetap dibatasi.
const STREAM_MEDIA_RE = /^\/api\/stream\/(hls|transcode|still|mjpeg)\b/;
app.use('/api', createRateLimiter(60_000, 200, null, (req) => STREAM_MEDIA_RE.test(req.originalUrl)));

// ─── Static: Logo and other root-level assets ─────────────────────────────
app.use('/assets', express.static(path.join(__dirname, '..'), {
  index: false,
  maxAge: '1d',
  dotfiles: 'deny',
  setHeaders(res, fp) {
    // Only allow image and safe types from root
    if (!/\.(jpe?g|png|gif|svg|ico|webp)$/i.test(fp)) {
      res.status(403).end();
    }
  },
}));

// ─── Frontend ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend'), {
  index: false,
  maxAge: '5m',
  setHeaders(res, fp) {
    // HTML selalu divalidasi (perubahan CSS/markup inline langsung termuat,
    // tak "nyangkut" versi lama di cache browser). Aset lain tetap di-cache.
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ─── API routes ───────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/recordings', recordingRoutes);
app.use('/api/ptz', ptzRoutes);

// ─── SPA routing ──────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dashboard.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ─── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  console.error(`[${req.method}] ${req.path} →`, err.message);
  res.status(status).json({
    error: config.nodeEnv === 'production' ? 'Internal Server Error' : err.message,
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────
function start() {
  initDatabase();
  startHealthChecker();
  // Panaskan indeks Bina Marga (URL jmlive segar) agar siap saat user buka kamera.
  try { require('./services/binaMargaResolver').prewarm(); } catch {}
  // Koordinat K3I dikunci: sync otomatis dimatikan agar posisi tidak berubah.
  // Re-sync manual masih bisa lewat endpoint admin bila sewaktu-waktu diperlukan.
  const { ffmpegAvailable } = require('./services/ffmpegCheck');
  app.listen(config.port, () => {
    console.log(`\nP4US CCTV running → http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`FFmpeg: ${ffmpegAvailable() ? `OK (${config.ffmpegPath}) — RTSP transcode aktif` : 'TIDAK TERPASANG — RTSP tidak bisa diputar'}`);
  });
}

start();
