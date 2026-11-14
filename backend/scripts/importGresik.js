/**
 * Importer CCTV Kabupaten Gresik (Diskominfo Gresik — "CCTV Kanjeng").
 * API publik: GET /api/v1/public/cctv?page=N (24/halaman, field `meta` = total).
 * Tiap kamera: id, name, status, hls_url (relatif), location_name, lat, lng.
 * Stream = HLS langsung https://cctvkanjeng.gresikkab.go.id<hls_url>.
 *
 * INSERT OR REPLACE by id (gresik_<uuid>). Aman dijalankan ulang.
 * Jalankan:  node backend/scripts/importGresik.js   (npm run import-gresik)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const ORIGIN = 'https://cctvkanjeng.gresikkab.go.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n !== 0 ? n : null; };

(async () => {
  initDatabase();
  const db = getDb();

  const all = [];
  let total = Infinity;
  for (let page = 1; page <= 50 && all.length < total; page++) {
    let j;
    try { j = (await axios.get(`${ORIGIN}/api/v1/public/cctv?page=${page}`, { timeout: 15000, headers: { 'User-Agent': UA, Accept: 'application/json' } })).data; }
    catch (e) { console.error('Gagal ambil halaman', page, ':', e.message); break; }
    const arr = Array.isArray(j) ? j : (j.data || Object.values(j).find(Array.isArray) || []);
    if (typeof j.meta === 'number') total = j.meta;
    if (!arr.length) break;
    all.push(...arr);
    if (arr.length < 24) break;
  }
  console.log('Kamera dari API Gresik:', all.length, '(total dilaporkan:', total === Infinity ? '?' : total, ')');
  if (!all.length) { console.error('Tak ada kamera terbaca.'); process.exit(1); }

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', 'cctvkanjeng.gresikkab.go.id',
       'Diskominfo Kabupaten Gresik', 'OPEN_NO_AUTH', @link,
       'stream', 'JATIM', 'Jawa Timur', @lat, @lng, @group, 'Pemda / Dishub')
  `);

  let seen = 0;
  transaction(() => {
    for (const c of all) {
      if (!c.id || !c.hls_url) continue;
      const link = /^https?:\/\//i.test(c.hls_url) ? c.hls_url : ORIGIN + (c.hls_url.startsWith('/') ? '' : '/') + c.hls_url;
      ins.run({
        id: 'gresik_' + c.id,
        name: (c.name || c.location_name || 'CCTV Gresik').trim(),
        link, lat: num(c.latitude), lng: num(c.longitude),
        group: 'Gresik · ' + (c.location_name || 'Diskominfo'),
      });
      seen++;
    }
  });

  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | kamera baru: ${after - before} | total DB: ${after}`);
})();
