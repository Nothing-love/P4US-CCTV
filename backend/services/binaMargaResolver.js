/**
 * Resolver URL SEGAR Jasa Marga via Bina Marga (publik, tanpa login, tanpa sesi).
 *
 * Halaman https://binamarga.pu.go.id/contents/cctv_tol/?id_ruas=<ruas> adalah
 * server-rendered dan memuat URL jmlive.jasamarga.com dengan UUID TERKINI untuk
 * tiap kamera (pasangan <source> + caption <h5> berurutan). Kita ambil halaman
 * tiap ruas, bangun indeks GLOBAL nama-ter-normalisasi → URL segar, lalu cocokkan
 * dengan nama kamera kita. Nama kamera kita (dari K3I) memakai konvensi yang sama
 * dengan caption Bina Marga, jadi cocok tanpa perlu tahu ruas per kamera.
 *
 * Indeks disegarkan sesuai TTL dan HANYA saat kamera jmlive diputar (bukan dari
 * health-check). Gagal → null → pemanggil pakai URL katalog sebagai fallback.
 */
const axios = require('axios');

const BASE = 'https://binamarga.pu.go.id/contents/cctv_tol/?id_ruas=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL_MS = 240_000;      // 4 menit — cukup segar untuk UUID yang berputar
const CONCURRENCY = 8;

// Daftar ruas tol Bina Marga (se-Indonesia). Mudah ditambah bila ada yang baru.
const RUAS = [
  '6-tol-dalam-kota-kelapa-gading-pulo-gebang', 'akses-tanjung-priok', 'bakaheuni-terbanggi-besar',
  'balikpapan-samarinda', 'bayung-lencir-tempino-jambi', 'bekasi-cawang-kampung-melayu',
  'belawan-medan-tanjung-morawa', 'bengkulu-taba-penanjung', 'binjai-langsa',
  'borr-sentul-barat-simpang-yasmin', 'cawang-tj-priok-ancol-timur-jembatan-tigapluit',
  'ciawi-sukabumi-ciawi-cibadak', 'cibitung-cilincing', 'cikampek-palimanan',
  'cileunyi-sumedang-dawuan', 'cimanggis-cibitung', 'cinere-jagorawi', 'cipularang',
  'dalam-kota', 'depok-antasari', 'gempol-pandaan', 'gempol-pasuruan', 'indralaya-prabumulih',
  'indrapura-kisaran', 'jakarta-bogor-ciawi', 'jakarta-cikampek', 'jakarta-cikampek-ii-selatan',
  'jakarta-tangerang', 'jalan-layang-mbz', 'jogja-solo', 'jorr-2-kunciran-cengkareng',
  'jorr-2-serpong-cinere', 'jorr-2-serpong-kunciran', 'jorr-e-bambu-apus-rorotan', 'jorr-s',
  'jorr-w1', 'jorr-w2-utara-kebon-jeruk-ulujami', 'jorr-w2s-pondok-ranji-ulujami-pondok-pinang',
  'jorr-w2u-ulujami-kembangan', 'kanci-pejagan', 'kayuagung-palembang-betung-kayuagung-kramasan',
  'kertosono-mojokerto', 'krian-legundi-bunder-manyar-krian-legundi-bunder',
  'kuala-tanjung-tebing-tinggi-parapat', 'kualanamu-tebing-tinggi', 'kunciran-serpong',
  'makassar-seksi-4', 'manado-bitung', 'medan-binjai', 'mojokerto-surabaya',
  'ngawi-kertosono-kediri', 'padalarang-cileunyi', 'padang-sicincin', 'palembang-indralaya',
  'palimanan-kanci', 'pandaan-malang', 'pasuruan-probolinggo', 'pejagan-pemalang',
  'pekanbaru-bangkinang', 'pekanbaru-dumai', 'pemalang-batang', 'pondok-aren-serpong',
  'probolinggo-banyuwangi', 'sedyatmo', 'semarang-batang', 'semarang-demak-seksi-2-sayung-demak',
  'semarang-abc', 'semarang-demak', 'semarang-solo', 'serang-panimbang-seksi-1-serang-rangkasbitung',
  'serpong-balaraja-seksi-1', 'serpong-cinere', 'sigli-banda-aceh',
  'simpang-susun-waru-bandara-juanda', 'solo-ngawi', 'soreang-pasirkoja', 'soroja-integrasi',
  'surabaya-gempol', 'surabaya-gresik', 'tangerang-merak',
  'terbanggi-besar-pematang-panggang-kayu-agung', 'ujung-pandang-seksi-1-3',
];

let index = null;        // Map: namaTernormalisasi → url
let indexAt = 0;
let inflight = null;

// Normalisasi nama agar cocok lintas format ("(MBZ) KM 18+000 L" ↔ caption BM).
function norm(s) {
  return String(s || '').toLowerCase().replace(/cctv_\w+/g, '').replace(/[^a-z0-9]/g, '');
}

function parsePage(html) {
  const srcs = [...html.matchAll(/jmlive\.jasamarga\.com\/hls\/(\d+)\/([0-9a-f-]+)\/index\.m3u8/g)];
  const caps = [...html.matchAll(/<h5[^>]*>\s*([^<]+?)\s*<\/h5>/gi)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  const n = Math.min(srcs.length, caps.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: caps[i], url: `https://jmlive.jasamarga.com/hls/${srcs[i][1]}/${srcs[i][2]}/index.m3u8` });
  }
  return out;
}

async function fetchRuas(ruas) {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await axios.get(BASE + ruas, { timeout: 15000, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } });
      return parsePage(String(r.data));
    } catch { if (a === 1) return []; await new Promise((res) => setTimeout(res, 1000)); }
  }
  return [];
}

async function refresh() {
  const map = new Map();
  for (let i = 0; i < RUAS.length; i += CONCURRENCY) {
    const batch = RUAS.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchRuas));
    for (const items of results) for (const it of items) if (!map.has(norm(it.name))) map.set(norm(it.name), it.url);
  }
  if (map.size) { index = map; indexAt = Date.now(); }
  return index;
}

// Picu refresh di latar bila indeks basi/kosong (tanpa memblokir pemanggil).
function kickRefresh() {
  if (!inflight && (!index || Date.now() - indexAt > TTL_MS)) {
    inflight = refresh().catch(() => null).finally(() => { inflight = null; });
  }
}

/**
 * Kembalikan URL jmlive SEGAR untuk nama kamera, atau null.
 * NON-BLOCKING: kalau indeks belum siap, kembalikan null (pemanggil pakai URL
 * katalog sbg fallback) dan refresh jalan di latar untuk permintaan berikutnya.
 * Membangun indeks 82 ruas ~belasan detik, jadi jangan menahan /info.
 */
async function resolveByName(name) {
  if (!name) return null;
  kickRefresh();
  return index ? (index.get(norm(name)) || null) : null;
}

/** Panaskan indeks saat server start agar siap sebelum user membuka kamera. */
function prewarm() { kickRefresh(); }

module.exports = { resolveByName, prewarm, norm };
