/**
 * Diagnosa struktur respons K3I v2 /cctv (JALANKAN DI SERVER, setelah Sync K3I
 * berhasil — memakai token/cookie yang tersimpan dari sync).
 *
 * Tujuan: lihat FIELD tiap kamera di v2 — khususnya apakah ada URL HLS/VMS yang
 * bisa diputar (vms.k3i-korlantas.id) selain RTSP mentah → untuk bangun "bridge"
 * agar kamera internal K3I tetap keluar gambar dari server kita.
 *
 * Jalankan:  node backend/scripts/diagK3iV2.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const config = require('../config');

const CACHE = path.join(os.tmpdir(), 'p4us-k3i-session.json');
const PORTAL = 'https://k3i.korlantas.polri.go.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const mask = (s) => String(s || '').replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@').replace(/(token|key|sig|auth)=[^&\s]+/gi, '$1=****');

(async () => {
  let sess;
  try { sess = JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
  catch { console.error('Belum ada sesi K3I tersimpan. Lakukan Sync K3I dulu.'); process.exit(1); }
  const valid = Date.now() < (sess.expiresAt || 0);
  if (!valid || (!sess.token && !sess.cookie)) { console.error('Sesi K3I tersimpan sudah kedaluwarsa. Sync ulang dulu.'); process.exit(1); }

  const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: `${PORTAL}/`, Origin: PORTAL };
  if (sess.cookie) headers.Cookie = sess.cookie; else headers.Authorization = sess.token;

  // Request SAMA seperti browser (v2 + filter), limit kecil utk lihat struktur.
  const url = `${config.k3i.baseUrl}/v2/cctv?filter%5B%5D=is_show&filter%5B%5D=is_active&filter%5B%5D=source_cctv_name&filterSearch%5B%5D=true&filterSearch%5B%5D=true%2Cfalse&filterSearch%5B%5D=KORLANTAS%2CUMUM%2CBAGOPS&limit=10000`;
  console.log('GET', url.replace(config.k3i.baseUrl, '…'));
  let data;
  try {
    const r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
    console.log('HTTP', r.status);
    if (r.status !== 200) { console.log('body:', mask(JSON.stringify(r.data)).slice(0, 300)); process.exit(1); }
    data = r.data;
  } catch (e) { console.error('ERR', e.message); process.exit(1); }

  const arr = Array.isArray(data) ? data : (data.data || data.result || data.cctv || Object.values(data).find(Array.isArray));
  if (!Array.isArray(arr)) { console.log('Struktur envelope:', Object.keys(data)); console.log(mask(JSON.stringify(data)).slice(0, 400)); process.exit(0); }
  console.log('Total kamera v2:', arr.length);
  console.log('\nFIELD per kamera:', Object.keys(arr[0] || {}).join(', '));

  console.log('\n--- 3 contoh kamera (nilai disamarkan) ---');
  for (const c of arr.slice(0, 3)) {
    console.log('\n' + JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, mask(String(v)).slice(0, 80)])), null, 1));
  }

  // Distribusi host dari SEMUA field yang berisi URL (cari field stream HLS/vms).
  const urlFields = {};
  for (const c of arr) {
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'string' && /^(https?|rtsp):\/\//.test(v)) {
        try { const h = new URL(v).hostname; (urlFields[k] = urlFields[k] || {})[h] = (urlFields[k][h] || 0) + 1; } catch {}
      }
    }
  }
  console.log('\n--- Field berisi URL → host (untuk temukan field HLS/vms) ---');
  for (const [f, hosts] of Object.entries(urlFields)) {
    console.log(`  ${f}:`, Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, n]) => `${h}(${n})`).join(', '));
  }
  process.exit(0);
})();
