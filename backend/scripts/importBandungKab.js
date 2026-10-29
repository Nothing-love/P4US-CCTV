/**
 * Importer CCTV Dishub Kabupaten Bandung.
 * Data tertanam di halaman: https://dishub.bandungkab.go.id/cctv/
 *   const cctvData = [{ id, name, code, coordinates:[lat,lng], streamUrl }, ...]
 * streamUrl = HLS cctv.bandungkab.go.id/.../s.m3u8?api=<token> (stabil).
 *
 * Jalankan:  node backend/scripts/importBandungKab.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const PAGE = 'https://dishub.bandungkab.go.id/cctv/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

(async () => {
  initDatabase();
  const db = getDb();
  let html;
  try { html = String((await axios.get(PAGE, { timeout: 20000, headers: { 'User-Agent': UA } })).data); }
  catch (e) { console.error('Gagal ambil halaman Dishub Bandung Kab:', e.message); process.exit(1); }

  // Parse tiap entri { id, name, coordinates:[lat,lng], streamUrl } dari cctvData.
  const block = (html.match(/const cctvData\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
  const entries = block.match(/\{[^{}]*streamUrl[^{}]*\}/g) || [];
  console.log('Entri CCTV Dishub Bandung Kab:', entries.length);
  if (!entries.length) { console.error('Tak menemukan cctvData.'); process.exit(1); }

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', @host, 'Dishub Kab. Bandung', 'OPEN_NO_AUTH', @link,
       'stream', 'JABAR', 'Jawa Barat', @lat, @lng, 'Bandung Kab (Dishub)', 'Pemda / Dishub')
  `);
  const upd = db.prepare('UPDATE cameras SET link = @link WHERE id = @id AND link != @link');

  let seen = 0;
  transaction(() => {
    for (const e of entries) {
      const id = (e.match(/id:\s*(\d+)/) || [])[1];
      const name = (e.match(/name:\s*"([^"]+)"/) || [])[1];
      const url = (e.match(/streamUrl:\s*"([^"]+)"/) || [])[1];
      const coord = (e.match(/coordinates:\s*\[([-\d.]+)\s*,\s*([-\d.]+)\]/) || []);
      if (!id || !url) continue;
      let host = 'cctv.bandungkab.go.id';
      try { host = new URL(url).hostname; } catch {}
      const row = {
        id: 'bdgkab_' + id,
        name: name || 'CCTV Bandung Kab',
        host, link: url,
        lat: num(coord[1]), lng: num(coord[2]),
      };
      ins.run(row); upd.run({ id: row.id, link: row.link });
      seen++;
    }
  });
  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | baru: ${after - before} | total DB: ${after}`);
})();
