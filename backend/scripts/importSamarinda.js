/**
 * Importer CCTV Kota Samarinda (Diskominfo Samarinda).
 * Sumber: portal resmi https://samarindakota.go.id/layanan/cctv yang menyiarkan
 * CCTV lewat YouTube Live, daftarnya di endpoint JSON /api/cctv/streams.
 *
 * Tiap wilayah = satu kamera tipe FRAME (iframe YouTube). youtubeId diisi dari
 * siaran LIVE terkini saat impor, TAPI karena ID berganti tiap hari, pemutaran
 * runtime memakai samarindaResolver (dipanggil di routes/stream.js) untuk ambil
 * ID segar — jadi impor cukup sekali, link disegarkan otomatis saat diputar.
 *
 * INSERT OR IGNORE: kamera yang sudah ada dipertahankan; link tetap di-UPDATE
 * bila ID live berubah. Aman dijalankan ulang.
 *
 * Jalankan:  node backend/scripts/importSamarinda.js   (npm run import-samarinda)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { initDatabase, getDb, transaction } = require('../db/database');
const { REGIONS, fetchStreams, embedUrl } = require('../services/samarindaResolver');

(async () => {
  initDatabase();
  const db = getDb();

  let live;
  try {
    live = await fetchStreams();   // Map: keyword → { youtubeId, title }
  } catch (e) {
    console.error('Gagal ambil daftar stream Samarinda:', e.message);
    process.exit(1);
  }
  console.log(`Wilayah terdaftar: ${REGIONS.length} | live saat impor: ${live.size}`);

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'FRAME', 'https', 'www.youtube-nocookie.com',
       'Diskominfo Kota Samarinda', 'OPEN_NO_AUTH', @link,
       'frame', 'KALTIM', 'Kalimantan Timur', @lat, @lng, @group_name, 'Pemda / Dishub')
  `);
  // Segarkan link bila ID live berubah sejak impor terakhir.
  const upd = db.prepare('UPDATE cameras SET link = @link WHERE id = @id AND link != @link');

  let seen = 0, skipped = 0;
  transaction(() => {
    for (const region of REGIONS) {
      const hit = live.get(region.keyword);
      if (!hit) { skipped++; continue; }   // tak live saat impor → dilewati; masuk saat impor berikutnya
      const row = {
        id: 'samarinda_' + region.slug,
        name: `${region.name} (Samarinda)`,
        link: embedUrl(hit.youtubeId),
        lat: region.lat,
        lng: region.lng,
        group_name: 'Samarinda · Diskominfo',
      };
      ins.run(row);
      upd.run({ id: row.id, link: row.link });
      seen++;
    }
  });

  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | dilewati (tak live): ${skipped} | kamera baru: ${after - before} | total DB: ${after}`);
})();
