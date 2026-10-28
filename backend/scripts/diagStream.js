/**
 * Diagnosa jmlive (Jasa Marga): cari kombinasi header yang mengeluarkan isi.
 * Menguji matriks Referer/Origin + uji "poll" (ulang beberapa kali dgn jeda,
 * untuk origin on-demand yang baru aktif setelah beberapa permintaan).
 *
 * Jalankan di SERVER:  node backend/scripts/diagStream.js [id|nama|url]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb } = require('../db/database');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieOf(res) {
  const sc = res.headers['set-cookie']; if (!sc) return '';
  return (Array.isArray(sc) ? sc : [sc]).map((s) => String(s).split(';')[0]).join('; ');
}
async function tryGet(url, { referer, origin, cookie } = {}) {
  const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'id,en;q=0.9' };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  try {
    const r = await axios.get(url, { timeout: 12000, validateStatus: (s) => s < 600, maxRedirects: 5, headers });
    const body = typeof r.data === 'string' ? r.data : '';
    return { status: r.status, bytes: body.length, m3u: body.includes('#EXTM3U'), cookie: cookieOf(r), acao: r.headers['access-control-allow-origin'] || '-' };
  } catch (e) { return { status: 'ERR', bytes: 0, m3u: false, err: e.message }; }
}

(async () => {
  initDatabase();
  const arg = process.argv[2];
  const db = getDb();
  let link = (arg && /^https?:/i.test(arg)) ? arg : null;
  if (!link) {
    const c = (arg && (db.prepare('SELECT link,name FROM cameras WHERE id=?').get(arg) || db.prepare('SELECT link,name FROM cameras WHERE name LIKE ? LIMIT 1').get('%' + arg + '%')))
      || db.prepare("SELECT link,name FROM cameras WHERE host='jmlive.jasamarga.com' AND link_type='M3U8' LIMIT 1").get();
    if (!c) { console.log('Tak ada kamera.'); process.exit(1); }
    link = c.link; console.log('Kamera:', c.name);
  }
  console.log('URL:', link, '\n');

  const referers = ['(tanpa)', 'https://jmlive.jasamarga.com/', 'https://www.jasamarga.com/',
    'https://tol.jasamarga.com/', 'https://jasamarga.com/', 'https://trafik.live/', 'https://trafik.live/cctv'];

  console.log('=== MATRIKS REFERER (cari yang bytes>0 & #EXTM3U) ===');
  let winner = null;
  for (const ref of referers) {
    for (const useOrigin of [false, true]) {
      // 2-langkah: ambil cookie dulu, lalu pakai
      const a = await tryGet(link, { referer: ref === '(tanpa)' ? '' : ref, origin: useOrigin ? 'https://trafik.live' : '' });
      const b = await tryGet(link, { referer: ref === '(tanpa)' ? '' : ref, origin: useOrigin ? 'https://trafik.live' : '', cookie: a.cookie });
      const tag = `ref=${ref.padEnd(32)} origin=${useOrigin ? 'ya ' : 'no '}`;
      console.log(`  ${tag} -> step1 ${a.status}/${a.bytes}b  step2 ${b.status}/${b.bytes}b m3u8=${b.m3u} acao=${b.acao}`);
      if (b.m3u && b.bytes > 0 && !winner) winner = { ref, useOrigin, cookie: b.cookie };
    }
  }

  console.log('\n=== UJI POLL (ulang 6x jeda 2s, origin on-demand) ===');
  let cookie = '';
  for (let i = 1; i <= 6; i++) {
    const r = await tryGet(link, { referer: 'https://jmlive.jasamarga.com/', cookie });
    cookie = r.cookie || cookie;
    console.log(`  coba ${i}: ${r.status} / ${r.bytes}b  #EXTM3U=${r.m3u}`);
    if (r.m3u && r.bytes > 0) { if (!winner) winner = { ref: 'poll', useOrigin: false, cookie }; break; }
    await sleep(2000);
  }

  console.log('\n==========================================');
  if (winner) console.log('DITEMUKAN kombinasi yang berhasil:', JSON.stringify({ referer: winner.ref, origin: winner.useOrigin }));
  else console.log('TIDAK ADA kombinasi header/poll yang mengeluarkan isi → jmlive butuh mekanisme lain (token/iframe).');
})().catch((e) => console.error('ERR', e.message));
