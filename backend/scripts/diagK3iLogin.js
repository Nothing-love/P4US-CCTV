/**
 * Diagnosa LOGIN K3I (JALANKAN DI SERVER).
 * Menunjukkan: (a) state sesi ter-cache (token/cooldown/kegagalan),
 * (b) hasil SATU percobaan login MENTAH ke endpoint K3I — status HTTP + ringkas
 *     body respons (disamarkan) — agar ketahuan kenapa resolver dapat null:
 *     cooldown? kredensial salah? sesi bentrok? rate-limit?
 *
 * Aman: hanya SATU percobaan login; tidak mengulang.
 * Jalankan:  node backend/scripts/diagK3iLogin.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const PORTAL_ORIGIN = 'https://k3i.korlantas.polri.go.id';
const CACHE = path.join(os.tmpdir(), 'p4us-k3i-session.json');

// Samarkan apa pun yang mirip token/rahasia di output.
function maskJson(obj) {
  let s = JSON.stringify(obj);
  s = s.replace(/("(?:accessToken|token|refreshToken|jwt)"\s*:\s*")[^"]+/gi, '$1****');
  if (s.length > 400) s = s.slice(0, 400) + '…';
  return s;
}

(async () => {
  console.log('K3I configured:', !!(config.k3i.username && config.k3i.password));
  console.log('baseUrl       :', config.k3i.baseUrl);
  console.log('username      :', config.k3i.username ? config.k3i.username.slice(0, 3) + '***' : '(kosong)');

  // (a) State cache
  try {
    const s = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const now = Date.now();
    console.log('\n[cache sesi]');
    console.log('  token valid    :', !!(s.token && now < s.expiresAt), s.expiresAt ? `(exp ${new Date(s.expiresAt).toISOString()})` : '');
    console.log('  cooldown aktif :', s.cooldownUntil && now < s.cooldownUntil ? `YA sampai ${new Date(s.cooldownUntil).toISOString()}` : 'tidak');
    console.log('  consecutiveFailures:', s.consecutiveFailures || 0);
  } catch { console.log('\n[cache sesi] tidak ada file cache'); }

  // (b) Satu login mentah
  console.log('\n[login mentah] POST', config.k3i.baseUrl + '/v1/auth/login');
  try {
    const res = await axios.post(
      `${config.k3i.baseUrl}/v1/auth/login`,
      { username: config.k3i.username, password: config.k3i.password },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/login` },
        validateStatus: () => true,
      }
    );
    console.log('  HTTP status :', res.status);
    console.log('  body        :', maskJson(res.data));
    const token = res.data?.data?.accessToken || res.data?.accessToken;
    console.log('  accessToken ditemukan?', token ? `YA (panjang ${String(token).length})` : 'TIDAK');
    if (res.status === 200 && token) {
      // Uji token: ambil 1 halaman cctv
      const cctv = await axios.get(`${config.k3i.baseUrl}/v3/cctv`, {
        params: { operation_id: config.k3i.operationId, page: 1, limit: 1 },
        headers: { Authorization: token, Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/` },
        timeout: 15000, validateStatus: () => true,
      });
      console.log('  uji /v3/cctv:', cctv.status, Array.isArray(cctv.data?.data) ? `(${cctv.data.data.length} item)` : '');
    }
  } catch (e) {
    console.log('  ERROR jaringan:', e.code || e.message);
  }
  process.exit(0);
})();
