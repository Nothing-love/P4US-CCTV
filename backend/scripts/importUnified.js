/**
 * Importer katalog trafik.live (1 file): catalog_trafik_live.csv
 * Menambahkan kamera trafik.live (926 titik, endpoint publik) ke database,
 * lengkap dengan link cadangan (backup_link) & jenis endpoint (stream/still/
 * frame). File-nya berisi SELURUH endpoint trafik.live yang sebelumnya tersebar
 * di beberapa katalog — kini disatukan jadi 1 file.
 *
 * INSERT OR IGNORE: kamera yang sudah ada (id sama) DIPERTAHANKAN apa adanya —
 * status runtime (health_status, k3i_active, client_alive_at) tidak terhapus.
 * Hanya kamera baru ('tl_...') yang ditambahkan. Aman dijalankan berulang.
 *
 * Jalankan:  node backend/scripts/importUnified.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { initDatabase, getDb, transaction } = require('../db/database');

const FILE = path.join(__dirname, '../../catalog_trafik_live.csv');

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function intOrNull(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

function run() {
  initDatabase();
  const db = getDb();

  if (!fs.existsSync(FILE)) {
    console.error('catalog_trafik_live.csv tidak ditemukan di root proyek.');
    process.exit(1);
  }
  const rows = parse(fs.readFileSync(FILE, 'utf8'), {
    columns: true, skip_empty_lines: true, relax_column_count: true,
  });

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       backup_link, backup_link_type, endpoint_kind, refresh_sec,
       province_code, province_name, lat, lng, group_name, category, credentials)
    VALUES
      (@id, @name, @type, @link_type, @scheme, @host, @owner, @access_class, @link,
       @backup_link, @backup_link_type, @endpoint_kind, @refresh_sec,
       @province_code, @province_name, @lat, @lng, @group_name, @category, @credentials)
  `);

  let seen = 0;
  transaction(() => {
    for (const r of rows) {
      if (!r.id || !r.link) continue;
      stmt.run({
        id: r.id,
        name: r.name || 'CCTV',
        type: r.type || 'CCTV',
        link_type: (r.link_type || '').toUpperCase() || null,
        scheme: r.scheme || null,
        host: r.host || null,
        owner: r.owner || null,
        access_class: r.access_class || null,
        link: r.link,
        backup_link: r.backup_link || null,
        backup_link_type: (r.backup_link_type || '').toUpperCase() || null,
        endpoint_kind: r.endpoint_kind || 'stream',
        refresh_sec: intOrNull(r.refresh),
        province_code: r.province_code || null,
        province_name: r.province_name || null,
        lat: num(r.lat),
        lng: num(r.lng),
        group_name: r.group_name || null,
        category: r.category || null,
        credentials: r.credentials || null,
      });
      seen++;
    }
  });

  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Baris diproses: ${seen} | kamera baru ditambahkan: ${after - before} | total DB: ${after}`);
}

run();
