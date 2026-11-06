/**
 * Resolver stream SEGAR CCTV Kota Samarinda (Diskominfo Samarinda).
 *
 * Portal https://samarindakota.go.id/layanan/cctv menyiarkan CCTV HANYA lewat
 * YouTube Live. Daftar stream diambil dari endpoint JSON portalnya:
 *   GET https://samarindakota.go.id/api/cctv/streams
 *     → { success, total, liveCount, data:[{ youtubeId, title, live }, ...] }
 *
 * PENTING: tiap kamera adalah siaran langsung YouTube HARIAN — judulnya memuat
 * tanggal (mis. "… Jembatan Mahakam 06/11/2026") dan youtubeId-nya BERGANTI tiap
 * hari saat siaran di-restart. Jadi menyimpan youtubeId statis akan hitam esok
 * hari. Resolver ini mengambil ID LIVE terkini per wilayah (dicocokkan via kata
 * kunci di judul) agar kamera tetap keluar gambar dari hari ke hari.
 *
 * Satu permintaan JSON ringan → boleh memblokir /info sebentar (beda dgn Bina
 * Marga yang 82 halaman). Hasil di-cache + dedup inflight; gagal → pakai cache
 * lama bila ada, kalau tidak null → pemanggil pakai URL katalog sbg fallback.
 */
const axios = require('axios');

const API = 'https://samarindakota.go.id/api/cctv/streams';
const PAGE = 'https://samarindakota.go.id/layanan/cctv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL_MS = 120_000;   // 2 menit — ID harian jarang berubah dalam sesi

// Sumber tunggal kebenaran daftar wilayah (dipakai resolver DAN importer).
// `keyword` = substring ter-normalisasi yang UNIK menandai wilayah di judul.
// lat/lng = perkiraan landmark Samarinda (untuk titik di peta; bukan presisi).
const REGIONS = [
  { slug: 'jembatan-mahakam',    name: 'Jembatan Mahakam',               keyword: 'jembatanmahakam',   lat: -0.5233, lng: 117.1469 },
  { slug: 'fly-over',            name: 'Fly Over',                       keyword: 'flyover',           lat: -0.4760, lng: 117.1540 },
  { slug: 'samarinda-utara',     name: 'Samarinda Utara',                keyword: 'samarindautara',    lat: -0.4450, lng: 117.1500 },
  { slug: 'samarinda-seberang',  name: 'Samarinda Seberang',             keyword: 'samarindaseberang', lat: -0.5340, lng: 117.1300 },
  { slug: 'lembus-sempaja',      name: 'Lembus – Sempaja',          keyword: 'lembus',            lat: -0.4470, lng: 117.1500 },
  { slug: 'air-putih-suryanata', name: 'Air Putih – Suryanata',     keyword: 'airputih',          lat: -0.4700, lng: 117.1270 },
  { slug: 'sei-dama-sambutan',   name: 'Sei Dama – Sambutan',       keyword: 'seidama',           lat: -0.4950, lng: 117.1850 },
  { slug: 'arh-basuki-rahmat',   name: 'Arief Rahman Hakim – Basuki Rahmat', keyword: 'ariefrahmanhakim', lat: -0.4900, lng: 117.1440 },
  { slug: 'bendungan-lempake',   name: 'Bendungan Lempake',              keyword: 'bendunganlempake',  lat: -0.4200, lng: 117.1820 },
];

let cache = null;     // Map: keyword → { youtubeId, title }
let cacheAt = 0;
let inflight = null;

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Bangun URL embed YouTube (konvensi proyek: youtube-nocookie + playsinline). */
function embedUrl(id) {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0`;
}

async function fetchStreams() {
  const r = await axios.get(`${API}?_=${Date.now()}`, {
    timeout: 8000,
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: PAGE },
  });
  const arr = Array.isArray(r.data && r.data.data) ? r.data.data : [];
  const live = arr.filter((e) => e && e.live && e.youtubeId);
  const map = new Map();
  for (const region of REGIONS) {
    const hit = live.find((e) => norm(e.title).includes(region.keyword));
    if (hit) map.set(region.keyword, { youtubeId: hit.youtubeId, title: hit.title });
  }
  return map;
}

/** Ambil indeks keyword→stream; cache TTL + dedup; gagal → cache lama/ null. */
async function getIndex() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchStreams()
      .then((m) => { cache = m; cacheAt = Date.now(); return m; })
      .finally(() => { inflight = null; });
  }
  try { return await inflight; }
  catch { return cache; }   // fetch gagal → pakai cache lama bila ada (boleh null)
}

/** URL embed LIVE terkini utk kamera `samarinda_<slug>`, atau null. */
async function resolveEmbedById(id) {
  const slug = String(id || '').replace(/^samarinda_/, '');
  const region = REGIONS.find((r) => r.slug === slug);
  if (!region) return null;
  const idx = await getIndex();
  const hit = idx && idx.get(region.keyword);
  return hit ? embedUrl(hit.youtubeId) : null;
}

/** Panaskan cache saat server start agar ID segar sebelum user buka kamera. */
function prewarm() { getIndex().catch(() => {}); }

module.exports = { REGIONS, embedUrl, fetchStreams, resolveEmbedById, prewarm, norm };
