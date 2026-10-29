/**
 * Importer CCTV Kota Bandung (PELINDUNG — Diskominfo Bandung).
 * Menarik langsung dari API publik:
 *   GET https://pelindung.bandung.go.id:8443/api/cek
 *     → [{ id, cctv_name, lat, lng, stream_cctv, dinas }, ...]  (±434 kamera)
 * stream_cctv = URL HLS (.m3u8) stabil di :3443 → disimpan sbg kamera M3U8.
 *
 * INSERT OR IGNORE: kamera yang sudah ada dipertahankan (status runtime aman).
 * Link tetap disegarkan (UPDATE) kalau berubah di sumber. Aman dijalankan ulang.
 *
 * Jalankan:  node backend/scripts/importBandung.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const API = 'https://pelindung.bandung.go.id:8443/api/cek';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

(async () => {
  initDatabase();
  const db = getDb();

  let cams;
  try {
    const r = await axios.get(API, { timeout: 20000, headers: { 'User-Agent': UA } });
    cams = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    console.error('Gagal ambil API Bandung:', e.message);
    process.exit(1);
  }
  console.log('Kamera dari API Pelindung Bandung:', cams.length);

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', @host, @owner, 'OPEN_NO_AUTH', @link,
       'stream', 'JABAR', 'Jawa Barat', @lat, @lng, @group_name, 'Pemda / Dishub')
  `);
  // Segarkan link kalau berubah di sumber (URL Bandung umumnya stabil).
  const upd = db.prepare('UPDATE cameras SET link = @link WHERE id = @id AND link != @link');

  let seen = 0;
  transaction(() => {
    for (const c of cams) {
      if (!c.id || !c.stream_cctv) continue;
      let host = 'pelindung.bandung.go.id';
      try { host = new URL(c.stream_cctv).hostname; } catch {}
      const row = {
        id: 'bdg_' + String(c.id).replace(/[^a-zA-Z0-9]/g, ''),
        name: c.cctv_name || 'CCTV Bandung',
        host,
        owner: ((c.dinas || 'Pemkot').trim()) + ' Kota Bandung',
        link: c.stream_cctv,
        lat: num(c.lat),
        lng: num(c.lng),
        group_name: 'Bandung · ' + (c.dinas || 'Pemkot'),
      };
      ins.run(row);
      upd.run({ id: row.id, link: row.link });
      seen++;
    }
  });

  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | kamera baru: ${after - before} | total DB: ${after}`);
})();
