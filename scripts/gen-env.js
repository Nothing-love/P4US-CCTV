/**
 * Generates a .env file with random secrets if one does not already exist.
 * Called by INSTALL-DAN-JALANKAN.bat on first setup.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  console.log('.env sudah ada — tidak diubah.');
  process.exit(0);
}

const secret = () => crypto.randomBytes(48).toString('hex');

// Port bisa diatur lewat env GEN_PORT atau argumen pertama (dipakai installer
// server/PM2 untuk port 6969). Default 3000 untuk pemakaian lokal.
const PORT = String(process.env.GEN_PORT || process.argv[2] || '3000').trim();

const contents = [
  `PORT=${PORT}`,
  'NODE_ENV=production',
  `JWT_SECRET=${secret()}`,
  `REFRESH_TOKEN_SECRET=${secret()}`,
  'ADMIN_EMAIL=admin@p4us.local',
  'RECORDINGS_DIR=./backend/recordings',
  `ALLOWED_ORIGINS=http://localhost:${PORT}`,
  '',
  '# K3I Korlantas operator bridge — isi dengan kredensial operator Anda',
  'K3I_BASE_URL=https://k3i.korlantas.polri.go.id/api/web',
  'K3I_USERNAME=',
  'K3I_PASSWORD=',
  'K3I_OPERATION_ID=286',
  '',
].join('\n');

fs.writeFileSync(envPath, contents, { mode: 0o600 });
console.log('.env dibuat.');
