/**
 * Importer CCTV Kota Malang (Diskominfo Kota Malang).
 * Portal https://cctv.malangkota.go.id (Next.js) menyematkan katalog lengkap di
 * data RSC (`initialCameras`): id, name, stream_id, koordinat, kecamatan, dan
 * pola HLS stream_server_base_url + stream_server_hls_pattern.
 *
 * Kota Malang pindah server stream: 245 kamera lama di DB kita (host
 * stream.cctv.malangkota.go.id) MATI. stream_id-nya cocok dgn katalog baru, jadi
 * baris lama DIHIDUPKAN (UPDATE link ke host baru m3u8cctv.malangkota.go.id),
 * kamera yang belum ada di-INSERT. Aman dijalankan ulang.
 *
 * Catatan: stream baru "session-gated" (index.m3u8?cookieCheck=1 → set cookie +
 * token session). Disimpan apa adanya; diputar lewat proxy /api/stream/hls.
 *
 * Jalankan:  node backend/scripts/importMalang.js   (npm run import-malang)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const URL = 'https://cctv.malangkota.go.id/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n !== 0 ? n : null; };

function parseCatalog(html) {
  // Satukan payload RSC Next.js, lalu ambil array initialCameras (balanced).
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)) { try { flight += JSON.parse('"' + m[1] + '"'); } catch { flight += m[1]; } }
  const k = flight.indexOf('"initialCameras":');
  if (k < 0) return [];
  let s = flight.indexOf('[', k), depth = 0, inStr = false, esc = false, j = s;
  for (; j < flight.length; j++) {
    const c = flight[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr) { if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { j++; break; } } }
  }
  try { return JSON.parse(flight.slice(s, j)); } catch { return []; }
}

(async () => {
  initDatabase();
  const db = getDb();

  let cams;
  try { cams = parseCatalog(String((await axios.get(URL, { timeout: 20000, headers: { 'User-Agent': UA } })).data)); }
  catch (e) { console.error('Gagal ambil portal Malang:', e.message); process.exit(1); }
  if (!cams.length) { console.error('Katalog Malang kosong — struktur RSC mungkin berubah.'); process.exit(1); }
  console.log('Kamera di katalog:', cams.length);

  const findOld = db.prepare("SELECT id FROM cameras WHERE host LIKE '%malangkota%' AND link LIKE ?");
  const revive = db.prepare(`UPDATE cameras SET link=@link, link_type='M3U8', scheme='https',
    host='m3u8cctv.malangkota.go.id', health_status='UNKNOWN', last_checked=NULL WHERE id=@id`);
  const ins = db.prepare(`
    INSERT OR IGNORE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', 'm3u8cctv.malangkota.go.id',
       'Diskominfo Kota Malang', 'OPEN_NO_AUTH', @link,
       'stream', 'JATIM', 'Jawa Timur', @lat, @lng, @group, 'Pemda / Dishub')
  `);

  let revived = 0, added = 0;
  transaction(() => {
    for (const c of cams) {
      if (!c.stream_id || !c.stream_server_base_url) continue;
      const pattern = c.stream_server_hls_pattern || '{base_url}/{stream_id}/index.m3u8';
      const link = pattern.replace('{base_url}', c.stream_server_base_url).replace('{stream_id}', c.stream_id);
      const old = findOld.get('%' + c.stream_id + '%');
      if (old) { revive.run({ id: old.id, link }); revived++; }
      else {
        ins.run({
          id: 'malang_' + c.stream_id,
          name: (c.name || 'CCTV Malang').trim(),
          link, lat: num(c.latitude), lng: num(c.longitude),
          group: 'Malang · ' + (c.nama_kecamatan || 'Diskominfo'),
        });
        added++;
      }
    }
  });
  console.log(`Dihidupkan (update host baru): ${revived} | kamera baru: ${added} | total katalog: ${cams.length}`);
})();
