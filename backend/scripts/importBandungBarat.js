/**
 * Importer CCTV ATCS Kabupaten Bandung Barat (Dishub KBB).
 * API publik: GET https://atcs.bandungbaratkab.go.id/get-cctv
 *   → [{ nama_cctv, alias, koordinat: "lat, lng", link: ".../<id>.html" }, ...]
 * Stream = datarhei restreamer HLS: urbanaccess.net/memfs/<id>.m3u8 (H.264).
 *
 * Jalankan:  node backend/scripts/importBandungBarat.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const API = 'https://atcs.bandungbaratkab.go.id/get-cctv';
const STREAM_BASE = 'https://atcs-dishubkbb.urbanaccess.net/memfs/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

(async () => {
  initDatabase();
  const db = getDb();
  let cams;
  try {
    const d = (await axios.get(API, { timeout: 20000, headers: { 'User-Agent': UA } })).data;
    cams = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : null);
  } catch (e) { console.error('Gagal ambil API ATCS KBB:', e.message); process.exit(1); }
  if (!Array.isArray(cams)) { console.error('Respons bukan array.'); process.exit(1); }
  console.log('Kamera ATCS Bandung Barat:', cams.length);

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', @host, 'Dishub Kab. Bandung Barat', 'OPEN_NO_AUTH', @link,
       'stream', 'JABAR', 'Jawa Barat', @lat, @lng, 'Bandung Barat (ATCS KBB)', 'Pemda / Dishub')
  `);
  const upd = db.prepare('UPDATE cameras SET link = @link WHERE id = @id AND link != @link');

  let seen = 0;
  transaction(() => {
    for (const c of cams) {
      const id = (String(c.link || '').match(/([0-9a-f-]{36})\.html/i) || [])[1];
      if (!id) continue;
      const [lat, lng] = String(c.koordinat || '').split(',').map((s) => num(s.trim()));
      const row = {
        id: 'kbb_' + id.replace(/[^a-z0-9]/gi, ''),
        name: c.nama_cctv || 'CCTV KBB',
        host: 'atcs-dishubkbb.urbanaccess.net',
        link: STREAM_BASE + id + '.m3u8',
        lat: lat ?? null, lng: lng ?? null,
      };
      ins.run(row); upd.run({ id: row.id, link: row.link });
      seen++;
    }
  });
  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | baru: ${after - before} | total DB: ${after}`);
})();
