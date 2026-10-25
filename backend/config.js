require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const pathMod = require('path');

/**
 * Resolve the FFmpeg binary path.
 * Priority: explicit FFMPEG_PATH env → bundled ./ffmpeg/bin → system "ffmpeg".
 */
function resolveFfmpeg() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && envPath !== 'ffmpeg' && fs.existsSync(envPath)) return envPath;

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = pathMod.join(__dirname, '..', 'ffmpeg', 'bin', exe);
  if (fs.existsSync(bundled)) return bundled;

  return envPath || 'ffmpeg';
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  jwt: {
    secret: process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET required'); })(),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    refreshSecret: process.env.REFRESH_TOKEN_SECRET || (() => { throw new Error('REFRESH_TOKEN_SECRET required'); })(),
    refreshExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'P4US CCTV <noreply@p4us.local>',
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@p4us.local',
    password: process.env.ADMIN_PASSWORD || null,
  },
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()),
  recordingsDir: process.env.RECORDINGS_DIR || require('path').join(__dirname, 'recordings'),
  ffmpegPath: resolveFfmpeg(),
  k3i: {
    baseUrl: process.env.K3I_BASE_URL || 'https://k3i.korlantas.polri.go.id/api/web',
    username: process.env.K3I_USERNAME || null,
    password: process.env.K3I_PASSWORD || null,
    operationId: parseInt(process.env.K3I_OPERATION_ID, 10) || 286,
  },
};
