/**
 * Importer PENUH kamera tol Bina Marga (jmlive), seluruh 82 ruas.
 * Menambahkan kamera tol yang BELUM ada di katalog (dedupe by nama) sebagai
 * entri M3U8 jmlive + jm_ruas, sehingga binaMargaResolver menyegarkan URL-nya
 * otomatis. Bina Marga tak menyediakan koordinat → kamera baru tanpa pin peta
 * (muncul di daftar), dikelompokkan per ruas tol.
 *
 * Jalankan:  node backend/scripts/importBinaMarga.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { initDatabase, getDb, transaction } = require('../db/database');
const bm = require('../services/binaMargaResolver');

// Slug ruas → nama tol yang mudah dibaca ("jakarta-cikampek" → "Tol Jakarta-Cikampek").
function readableRuas(slug) {
  const s = slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bMbz\b/i, 'MBZ').replace(/\bJorr\b/i, 'JORR').replace(/\bBorr\b/i, 'BORR')
    .replace(/\bGt\b/i, 'GT').replace(/\bSs\b/i, 'SS').replace(/\bAbc\b/i, 'ABC');
  return 'Tol ' + s;
}

(async () => {
  initDatabase();
  const db = getDb();

  // Set nama ter-normalisasi kamera jmlive yang SUDAH ada → untuk dedupe.
  const existing = new Set(
    db.prepare("SELECT name FROM cameras WHERE host='jmlive.jasamarga.com'").all().map((r) => bm.norm(r.name))
  );
  console.log('Kamera jmlive existing (dedupe):', existing.size);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_name, group_name, category, jm_ruas)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', 'jmlive.jasamarga.com', 'Jasa Marga', 'OPEN_NO_AUTH', @link,
       'stream', 'Indonesia', @group_name, 'Jasa Marga', @jm_ruas)
  `);

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  let fetched = 0, added = 0, skipped = 0, ruasOk = 0;
  const RUAS = bm.RUAS;

  for (let i = 0; i < RUAS.length; i += 4) {
    const batch = RUAS.slice(i, i + 4);
    const results = await Promise.all(batch.map(async (ruas) => ({ ruas, cams: await bm.fetchRuasCameras(ruas) })));
    transaction(() => {
      for (const { ruas, cams } of results) {
        if (cams.length) ruasOk++;
        const group = readableRuas(ruas);
        const seenInRuas = new Set();
        for (const c of cams) {
          fetched++;
          const key = bm.norm(c.name);
          if (!key || seenInRuas.has(key)) continue;   // dedupe dalam ruas
          seenInRuas.add(key);
          if (existing.has(key)) { skipped++; continue; } // sudah ada di katalog
          existing.add(key);  // tandai ditangani agar ruas lain tak menambah nama sama
          const r = ins.run({
            id: 'bm_' + ruas.slice(0, 10) + '_' + key.slice(0, 24),
            name: c.name, link: c.url, group_name: group, jm_ruas: ruas,
          });
          if (r.changes > 0) added++;
        }
      }
    });
    process.stdout.write(`\r  ruas ${Math.min(i + 4, RUAS.length)}/${RUAS.length} | fetched=${fetched} added=${added} skip=${skipped}   `);
    if (i + 4 < RUAS.length) await new Promise((res) => setTimeout(res, 700));
  }
  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`\nRuas berhasil: ${ruasOk}/${RUAS.length} | kamera BM: ${fetched} | BARU ditambah: ${added} | dilewati (dedupe): ${skipped} | total DB: ${after} (+${after - before})`);
})();
