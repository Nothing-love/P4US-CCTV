/**
 * Import Bali Tower (Pemprov DKI Jakarta) CCTV catalog into SQLite.
 * Streams are open HLS on port 8011 with CORS "*", so the browser can play
 * them directly. Run: node backend/scripts/importBaliTower.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { initDatabase, getDb, transaction } = require('../db/database');

const CSV = path.join(__dirname, '../../catalog_balitower.csv');
const HOST = 'cctv.balitower.co.id';
const PORT = 8011;

function run() {
  if (!fs.existsSync(CSV)) {
    console.error(`File katalog tidak ditemukan: ${CSV}`);
    process.exit(1);
  }
  initDatabase();
  const db = getDb();

  const records = parse(fs.readFileSync(CSV, 'utf8'), {
    columns: true, skip_empty_lines: true, relax_column_count: true,
  });

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cameras
      (id, name, type, link_type, scheme, host, owner,
       has_token, has_cred, access_class, link,
       province_code, province_name, lat, lng, group_name, category, k3i_active)
    VALUES
      (@id, @name, @type, @link_type, @scheme, @host, @owner,
       0, 0, 'OPEN_NO_AUTH', @link,
       'DKI', 'DKI Jakarta', @lat, @lng, @group_name, 'Bali Tower (Jakarta)', 1)
  `);

  let n = 0;
  const rows = records.map((r) => {
    const stream = (r.stream || '').trim();
    if (!stream) return null;
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);
    return {
      id: `balitower_${stream}`,
      name: (r.name || stream).trim(),
      type: (r.kota || 'Jakarta').trim(),
      link_type: 'M3U8',
      scheme: 'https',
      host: HOST,
      owner: 'Bali Tower (Pemprov DKI Jakarta)',
      link: `https://${HOST}:${PORT}/${stream}/index.m3u8`,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      group_name: HOST,
    };
  }).filter(Boolean);

  transaction(() => { for (const row of rows) { stmt.run(row); n++; } });

  console.log(`Imported ${n} kamera Bali Tower.`);
  const total = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Total kamera di DB sekarang: ${total}`);
  process.exit(0);
}

run();
