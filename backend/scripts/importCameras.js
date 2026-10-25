/**
 * Imports cameras from CSV catalog files into SQLite database.
 * Run: node backend/scripts/importCameras.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { initDatabase, getDb, transaction } = require('../db/database');
const { extractRegion } = require('../services/regionExtractor');

const DATA_DIR = path.join(__dirname, '../../');

// Master catalog contains all cameras; smaller files are subsets
const CSV_FILES = [
  { file: 'catalog_cctv.csv',    accessClass: null },  // use access_class from CSV
  { file: 'catalog_token.csv',   accessClass: null },  // token-based cameras
];

function parseBool(val) {
  if (!val) return 0;
  return val.toUpperCase() === 'YA' || val === '1' || val === 'true' ? 1 : 0;
}

function loadCameras() {
  initDatabase();
  const db = getDb();

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO cameras
      (id, name, type, link_type, scheme, host, owner,
       has_token, has_cred, access_class, link,
       province_code, province_name, lat, lng, group_name)
    VALUES
      (@id, @name, @type, @link_type, @scheme, @host, @owner,
       @has_token, @has_cred, @access_class, @link,
       @province_code, @province_name, @lat, @lng, @group_name)
  `);

  function insertMany(rows) {
    transaction(() => { for (const row of rows) insertStmt.run(row); });
  }

  let total = 0;

  for (const { file, accessClass } of CSV_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping missing file: ${file}`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const records = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });

    const batch = records.map((r) => {
      const cam = {
        id: r.id || r['id'],
        name: r.name || r['name'] || 'Unknown',
        type: r.type || '',
        link_type: r.linkType || r['linkType'] || '',
        scheme: r.scheme || '',
        host: r.host || '',
        owner: r.owner || '',
        has_token: parseBool(r.has_token || r['has_token']),
        has_cred: parseBool(r.has_cred || r['has_cred']),
        access_class: r.access_class || r['access_class'] || accessClass,
        link: r.link || '',
        group_name: r.host || '',
      };

      const region = extractRegion(cam);
      cam.province_code = region.provinceCode;
      cam.province_name = region.provinceName;
      cam.lat = region.lat;
      cam.lng = region.lng;

      return cam;
    }).filter(c => c.id && c.link);

    insertMany(batch);
    console.log(`Imported ${batch.length} cameras from ${file}`);
    total += batch.length;
  }

  console.log(`\nTotal imported: ${total} cameras`);
  process.exit(0);
}

loadCameras();
