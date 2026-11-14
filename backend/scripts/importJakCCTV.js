/**
 * Importer 5 lokasi CCTV publik DKI (JakCCTV Diskominfotik) yang BELUM ada di DB.
 * Portal https://jakcctv.jakarta.go.id/publik menampilkan 52 kamera Bali Tower;
 * 42 sudah kita punya, 10 feed (5 lokasi × CCTV-01/02) di host
 * dki-jkt.balitower.co.id:7028 belum — itu yang ditambahkan di sini.
 *
 * Stream HLS terbuka (tanpa token, CORS *), identik dgn 1708 kamera Bali Tower
 * lain → disimpan link_type M3U8, kategori "Bali Tower (Jakarta)".
 *
 * INSERT OR IGNORE by id (balitower_<slug>) → aman dijalankan ulang, tak duplikat.
 * Jalankan:  node backend/scripts/importJakCCTV.js   (npm run import-jakcctv)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { initDatabase, getDb, transaction } = require('../db/database');

const HOST = 'dki-jkt.balitower.co.id';
const PORT = 7028;
// 5 lokasi; tiap lokasi punya feed CCTV-01 & CCTV-02. lat/lng PERKIRAAN tingkat
// ruas jalan (portal tak menyediakan koordinat) — cukup untuk titik di peta.
const LOCATIONS = [
  { base: '502507_JKP_SATPOL-PP_JL.-JEND.-GATOT-SUBROTO-C11',          name: 'JKP SATPOL PP — Jl. Jend. Gatot Subroto C11',          lat: -6.2235, lng: 106.8130 },
  { base: '502645_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C08',    name: 'JKB SATPOL PP — Simpang Jl. Letjen S. Parman C08',      lat: -6.1915, lng: 106.7960 },
  { base: '503303_JKP_POLDA_JL.-JEND.-GATOT-SUBROTO-C14',              name: 'JKP POLDA — Jl. Jend. Gatot Subroto C14',              lat: -6.2345, lng: 106.8060 },
  { base: '501941_JKP_SATPOLPP_JL.-MH.-THAMRIN-C02',                   name: 'JKP SATPOL PP — Jl. MH. Thamrin C02',                  lat: -6.1930, lng: 106.8225 },
  { base: '502540_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C02',    name: 'Pasar Tanah Abang — Simpang Jl. Letjen S. Parman C02', lat: -6.1855, lng: 106.8110 },
];

initDatabase();
const db = getDb();

const ins = db.prepare(`
  INSERT OR IGNORE INTO cameras
    (id, name, type, link_type, scheme, host, owner, access_class, link,
     endpoint_kind, province_code, province_name, lat, lng, group_name, category, k3i_active)
  VALUES
    (@id, @name, 'CCTV', 'M3U8', 'https', '${HOST}',
     'Diskominfotik DKI Jakarta (Bali Tower)', 'OPEN_NO_AUTH', @link,
     'stream', 'DKI', 'DKI Jakarta', @lat, @lng, 'Jakarta · JakCCTV (Diskominfotik)', 'Bali Tower (Jakarta)', 1)
`);

const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
let seen = 0;
transaction(() => {
  for (const loc of LOCATIONS) {
    for (const cam of ['CCTV-01', 'CCTV-02']) {
      const slug = `${loc.base}_${cam}`;
      ins.run({
        id: `balitower_${slug}`,
        name: `${loc.name} (${cam})`,
        link: `https://${HOST}:${PORT}/${slug}/index.fmp4.m3u8`,
        lat: loc.lat,
        lng: loc.lng,
      });
      seen++;
    }
  }
});

const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
console.log(`Diproses: ${seen} feed | kamera baru: ${after - before} | total DB: ${after}`);
