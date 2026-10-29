/**
 * Diagnosa PRESISI Jasa Marga (JALANKAN DI SERVER).
 * Memastikan di mana rantai putus untuk kamera jmlive yang hitam:
 *   1) Apakah resolver K3I memberi URL SEGAR (beda dari katalog)?
 *   2) Apakah fetch SERVER-SIDE URL segar itu keluar isinya (#EXTM3U/#EXTINF)?
 *   3) Apakah jmlive mengirim header CORS (penentu bisa/tidak diputar LANGSUNG
 *      dari browser tanpa proxy, seperti trafik.live)?
 *
 * Jalankan:  node backend/scripts/diagJmliveFetch.js ["nama kamera"]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb } = require('../db/database');
const k3iResolver = require('../services/k3iResolver');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const arg = process.argv[2];

function cookieOf(res) {
  const sc = res.headers['set-cookie']; if (!sc) return '';
  return (Array.isArray(sc) ? sc : [sc]).map((s) => String(s).split(';')[0]).join('; ');
}

async function fetchTwice(url) {
  const g = (cookie) => axios.get(url, {
    timeout: 12000, validateStatus: () => true, maxRedirects: 3,
    headers: { 'User-Agent': UA, Referer: 'https://jmlive.jasamarga.com/', ...(cookie ? { Cookie: cookie } : {}) },
  });
  const r1 = await g(null);
  const r2 = await g(cookieOf(r1));
  const body = typeof r2.data === 'string' ? r2.data : '';
  return {
    status: r2.status, bytes: body.length,
    m3u: body.includes('#EXTM3U'), extinf: /#EXTINF/i.test(body),
    acao: r2.headers['access-control-allow-origin'] || '(tidak ada)',
    ctype: r2.headers['content-type'] || '-',
    firstVariant: (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').trim(),
    sample: body.slice(0, 140).replace(/\n/g, ' '),
  };
}

(async () => {
  initDatabase();
  const db = getDb();
  const cam = (arg
    ? db.prepare("SELECT * FROM cameras WHERE name LIKE ? AND host='jmlive.jasamarga.com' LIMIT 1").get('%' + arg + '%')
    : null)
    || db.prepare("SELECT * FROM cameras WHERE host='jmlive.jasamarga.com' AND id LIKE 'cctv_%' LIMIT 1").get();
  if (!cam) { console.log('Tak ada kamera jmlive cctv_.'); process.exit(1); }

  console.log('Kamera :', cam.name, '(' + cam.id + ')');
  console.log('URL katalog :', cam.link);

  // 1) Resolver K3I
  const fresh = await k3iResolver.resolveById(cam.id);
  console.log('\n[1] Resolver K3I:', fresh ? 'DAPAT URL' : 'GAGAL (null)');
  if (fresh) {
    console.log('    URL segar  :', fresh.link);
    console.log('    beda dari katalog?', fresh.link !== cam.link ? 'YA (UUID berputar)' : 'tidak');
  }

  // 2) Fetch server-side URL segar (atau katalog bila resolver gagal)
  const target = fresh?.link || cam.link;
  console.log('\n[2] Fetch SERVER-SIDE:', target.slice(0, 75) + '...');
  const r = await fetchTwice(target);
  console.log(`    status=${r.status} bytes=${r.bytes} #EXTM3U=${r.m3u} #EXTINF=${r.extinf} ctype=${r.ctype}`);
  if (r.m3u && !r.extinf && r.firstVariant) {
    const vu = new URL(r.firstVariant, target).href;
    const r2 = await fetchTwice(vu);
    console.log(`    varian-1: status=${r2.status} bytes=${r2.bytes} #EXTINF=${r2.extinf}`);
  }
  console.log('    isi(140):', r.sample || '(kosong)');

  // 3) CORS (penentu direct-play)
  console.log('\n[3] CORS Access-Control-Allow-Origin:', r.acao);
  console.log('    → bisa diputar LANGSUNG dari browser?', r.acao !== '(tidak ada)' ? 'YA' : 'TIDAK (perlu proxy)');

  console.log('\n=== KESIMPULAN ===');
  if (!fresh) console.log('Resolver gagal → cek login K3I di server (mungkin cooldown/kredensial).');
  else if (r.extinf) console.log('URL segar KELUAR ISI di server → proxy mestinya jalan. Masalah mungkin di sisi lain (codec/CSP/frontend).');
  else if (r.acao !== '(tidak ada)') console.log('Server-side kosong TAPI CORS ada → putar LANGSUNG dari browser (direct), bukan proxy.');
  else console.log('Server-side kosong & tanpa CORS → jmlive menolak non-browser. Perlu strategi lain (direct via browser dgn UUID segar).');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
