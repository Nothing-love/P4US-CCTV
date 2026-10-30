/**
 * Cek korelasi is_active vs host link di K3I v2 (pakai sesi tersimpan).
 * Jawab: berapa kamera RTSP yang is_active=false (mati di K3I juga), dan
 * berapa RTSP yang is_active=true (seharusnya bisa).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs'); const os = require('os'); const path = require('path');
const axios = require('axios');
const config = require('../config');
const CACHE = path.join(os.tmpdir(), 'p4us-k3i-session.json');
const PORTAL = 'https://k3i.korlantas.polri.go.id';

(async () => {
  const sess = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const headers = { Accept: 'application/json', Referer: `${PORTAL}/`, Origin: PORTAL };
  if (sess.cookie) headers.Cookie = sess.cookie; else headers.Authorization = sess.token;
  const url = `${config.k3i.baseUrl}/v2/cctv?filter%5B%5D=is_show&filter%5B%5D=is_active&filter%5B%5D=source_cctv_name&filterSearch%5B%5D=true&filterSearch%5B%5D=true%2Cfalse&filterSearch%5B%5D=KORLANTAS%2CUMUM%2CBAGOPS&limit=10000`;
  const arr = (await axios.get(url, { headers, timeout: 30000 })).data;
  const cams = Array.isArray(arr) ? arr : arr.data;

  const kind = (c) => {
    const l = c.link || '';
    if (/jmlive\.jasamarga/.test(l)) return 'jmlive(HLS)';
    if (/vms\.k3i-korlantas/.test(l)) return 'vms(HLS)';
    if (/^rtsp:/.test(l)) return 'RTSP';
    if (/\.go\.id/.test(l)) return 'go.id(HLS)';
    if (/^https?:/.test(l)) return 'HTTP(lain)';
    return 'lain';
  };
  const tbl = {};
  let activeTrue = 0, activeFalse = 0;
  for (const c of cams) {
    const act = String(c.is_active) === 'true';
    if (act) activeTrue++; else activeFalse++;
    const k = kind(c);
    tbl[k] = tbl[k] || { aktif: 0, nonaktif: 0 };
    tbl[k][act ? 'aktif' : 'nonaktif']++;
  }
  console.log('Total:', cams.length, '| is_active=true:', activeTrue, '| is_active=false:', activeFalse);
  console.log('\nJENIS LINK'.padEnd(16), 'AKTIF'.padStart(8), 'NONAKTIF'.padStart(10));
  console.log('-'.repeat(38));
  for (const [k, v] of Object.entries(tbl).sort((a, b) => (b[1].aktif + b[1].nonaktif) - (a[1].aktif + a[1].nonaktif))) {
    console.log(k.padEnd(16), String(v.aktif).padStart(8), String(v.nonaktif).padStart(10));
  }
  const rtsp = tbl['RTSP'] || { aktif: 0, nonaktif: 0 };
  console.log(`\n→ RTSP aktif (seharusnya bisa dari IP publik): ${rtsp.aktif}`);
  console.log(`→ RTSP nonaktif (mati di K3I juga, tandai offline): ${rtsp.nonaktif}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
