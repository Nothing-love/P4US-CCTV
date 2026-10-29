/**
 * Diagnosa: bagaimana K3I menyajikan kamera JASA MARGA?
 *
 * Kamera Jasa Marga di katalog kita (host jmlive.jasamarga.com) sering LAYAR
 * HITAM karena UUID stream-nya BERPUTAR → URL katalog basi. Trafik.live
 * mengatasinya dengan URL segar. Anda menyebut: di K3I, Jasa Marga hidup lancar.
 *
 * Skrip ini (JALANKAN DI SERVER tempat login K3I berhasil) melakukan SATU login
 * lalu memeriksa apakah daftar kamera K3I memuat kamera Jasa Marga/tol, dan URL
 * apa yang dipakainya — agar resolver bisa mengambil URL SEGAR dari K3I.
 *
 * Jalankan:  node backend/scripts/diagK3iJasamarga.js
 * Output aman dibagikan (kredensial/token disamarkan).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const k3iBridge = require('../services/k3iBridge');
const { initDatabase, getDb } = require('../db/database');

const mask = (s) => String(s || '')
  .replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@')
  .replace(/(token|key|sig|auth|hash)=[^&\s]+/gi, '$1=****');

(async () => {
  if (!k3iBridge.isConfigured()) {
    console.log('K3I belum dikonfigurasi di .env (K3I_USERNAME/K3I_PASSWORD).');
    process.exit(1);
  }
  console.log('Mengambil daftar kamera K3I (satu login)...');
  let cams;
  try { cams = await k3iBridge.getCameras(); }
  catch (e) { console.error('GAGAL login/ambil daftar K3I:', e.message); process.exit(1); }
  console.log('Total kamera di K3I:', cams.length);

  if (cams[0]) console.log('\nField per entri:', Object.keys(cams[0]).join(', '));

  // Kamera berkaitan Jasa Marga / tol
  const isJM = (c) => /jasa\s*marga|jmlive|\bmbz\b|cikampek|jagorawi|tol\b|layang|gerbang|\bgt\b/i.test(JSON.stringify(c));
  const jm = cams.filter(isJM);
  console.log(`\nKamera Jasa Marga/tol di K3I: ${jm.length}`);
  for (const c of jm.slice(0, 10)) {
    const link = c.link || c.url || c.streamUrl || c.rtsp || '';
    console.log(`\n  id=${c.id}`);
    console.log(`    name=${c.name || c.cctvName || c.title || '-'}`);
    console.log(`    linkType=${c.linkType || c.link_type || c.type || '-'} active=${c.isActive ?? c.active ?? '-'}`);
    console.log(`    link=${mask(link).slice(0, 110)}`);
  }

  // Distribusi host semua link K3I (biar tahu infrastruktur stream-nya)
  const hosts = {};
  for (const c of cams) {
    const l = c.link || c.url || c.streamUrl || c.rtsp || '';
    try { const h = new URL(l).hostname; hosts[h] = (hosts[h] || 0) + 1; } catch {}
  }
  console.log('\n--- Host stream di daftar K3I (top 15) ---');
  Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([h, n]) => console.log(`  ${h}: ${n}`));

  // Coba cocokkan beberapa kamera jmlive DB kita ke entri K3I (by nama mirip)
  try {
    initDatabase();
    const db = getDb();
    const ours = db.prepare("SELECT name FROM cameras WHERE host='jmlive.jasamarga.com' LIMIT 5").all();
    console.log('\n--- Uji cocok nama kamera jmlive kita vs K3I ---');
    for (const o of ours) {
      const key = o.name.replace(/[^0-9a-z]/gi, '').toLowerCase();
      const hit = cams.find((c) => {
        const n = (c.name || c.cctvName || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
        return n && (n.includes(key) || key.includes(n));
      });
      console.log(`  "${o.name}" → ${hit ? 'COCOK: ' + (hit.name || hit.cctvName) : 'tak ada padanan'}`);
    }
  } catch (e) { console.log('(lewati uji cocok DB:', e.message, ')'); }

  process.exit(0);
})();
