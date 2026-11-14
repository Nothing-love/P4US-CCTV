/**
 * Importer CCTV Kota Semarang (PANTAUSEMAR — Diskominfo Kota Semarang).
 * Portal https://pantausemar.semarangkota.go.id menyematkan daftar kamera di
 * variabel `cctvs` per-kategori di HTML halaman. Kita ambil daftar kategori dari
 * halaman utama, lalu tiap kategori diambil & disatukan (dedup per URL stream).
 *
 * Stream = HLS langsung https://livepantau.semarangkota.go.id/<uuid>/index.m3u8
 * (link_type M3U8, diputar lewat proxy /api/stream/hls seperti sumber M3U8 lain).
 * URL uuid stabil → impor statis, aman dijalankan ulang (INSERT OR REPLACE by id).
 *
 * Jalankan:  node backend/scripts/importSemarang.js   (npm run import-semarang)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const { initDatabase, getDb, transaction } = require('../db/database');

const BASE = 'https://pantausemar.semarangkota.go.id/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Ambil array JSON yg di-assign ke `cctvs = [ ... ]` di HTML (balanced bracket,
// sadar string agar tak terpotong oleh ']' di dalam teks).
function extractCctvs(html) {
  const m = html.match(/cctvs\s*=\s*\[/);
  if (!m) return [];
  let s = html.indexOf('[', m.index), depth = 0, inStr = false, esc = false, j = s;
  for (; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr) { if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { j++; break; } } }
  }
  try { return JSON.parse(html.slice(s, j)); } catch { return []; }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const get = (url) => axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA } }).then((r) => String(r.data));

(async () => {
  initDatabase();
  const db = getDb();

  let base;
  try { base = await get(BASE); }
  catch (e) { console.error('Gagal ambil portal Semarang:', e.message); process.exit(1); }

  const catIds = [...new Set([...base.matchAll(/cctv_category_id=([0-9a-f-]{36})/gi)].map((m) => m[1]))];
  console.log('Kategori:', catIds.length);

  // Satukan semua kamera lintas kategori, dedup per URL stream.
  const byUrl = new Map();
  for (const id of catIds) {
    let arr = [];
    try { arr = extractCctvs(await get(BASE + '?cctv_category_id=' + id)); } catch { /* lewati kategori gagal */ }
    for (const o of arr) for (const l of (o.links || [])) {
      if (l.url && /\.m3u8/i.test(l.url) && !byUrl.has(l.url)) {
        byUrl.set(l.url, { url: l.url, name: (l.name || o.owner_name || 'CCTV Semarang').trim(), lat: num(o.lat), lng: num(o.lng) });
      }
    }
  }
  const cams = [...byUrl.values()];
  console.log('Kamera unik:', cams.length);
  if (!cams.length) { console.error('Tak ada kamera terbaca — struktur portal mungkin berubah.'); process.exit(1); }

  const before = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO cameras
      (id, name, type, link_type, scheme, host, owner, access_class, link,
       endpoint_kind, province_code, province_name, lat, lng, group_name, category)
    VALUES
      (@id, @name, 'CCTV', 'M3U8', 'https', 'livepantau.semarangkota.go.id',
       'Diskominfo Kota Semarang', 'OPEN_NO_AUTH', @link,
       'stream', 'JATENG', 'Jawa Tengah', @lat, @lng, 'Semarang · PANTAUSEMAR', 'Pemda / Dishub')
  `);

  let seen = 0;
  transaction(() => {
    for (const c of cams) {
      const uuid = (c.url.match(/([0-9a-f-]{36})/i) || [])[1] || c.url.replace(/[^a-z0-9]/gi, '').slice(-24);
      ins.run({ id: 'semarang_' + uuid, name: c.name, link: c.url, lat: c.lat, lng: c.lng });
      seen++;
    }
  });

  const after = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`Diproses: ${seen} | kamera baru: ${after - before} | total DB: ${after}`);
})();
