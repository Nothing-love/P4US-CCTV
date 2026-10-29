/**
 * Resolver URL SEGAR Jasa Marga (dan kamera K3I lain) lewat sesi K3I.
 *
 * Kamera kita ber-ID `cctv_...` BERASAL dari K3I dengan ID yang SAMA. URL stream
 * jmlive.jasamarga.com memakai UUID yang BERPUTAR, sehingga URL di katalog cepat
 * basi → layar hitam. Daftar kamera K3I (/v3/cctv) selalu memuat URL TERKINI.
 *
 * Resolver ini menyimpan cache seluruh daftar kamera K3I (id → link terkini) dan
 * menyegarkannya sesuai TTL. Satu panggilan API K3I melayani SEMUA kamera, dan
 * hanya dipanggil saat kamera benar-benar diputar (bukan dari health-check), jadi
 * tidak pernah "mengetuk" portal secara beruntun. Token dipakai ulang (~50 mnt),
 * jadi login sangat jarang. Bila K3I gagal (cooldown/401), kembalikan null → route
 * memakai URL katalog sebagai fallback.
 */
const k3iBridge = require('./k3iBridge');

const TTL_MS = 150_000;          // 2,5 menit — cukup segar untuk UUID yang berputar
let cache = null;                // Map: id → { link, linkType }
let cacheAt = 0;
let inflight = null;             // dedup refresh saat banyak slot dibuka bersamaan

async function refresh() {
  const cams = await k3iBridge.getCameras();
  const map = new Map();
  for (const c of cams) {
    if (c && c.id && c.link) {
      map.set(c.id, { link: c.link, linkType: (c.linkType || '').toUpperCase() || null });
    }
  }
  cache = map;
  cacheAt = Date.now();
  return map;
}

/**
 * Kembalikan { link, linkType } terkini untuk satu id kamera K3I, atau null.
 */
async function resolveById(id) {
  if (!id) return null;
  const fresh = cache && (Date.now() - cacheAt < TTL_MS);
  if (!fresh) {
    if (!inflight) inflight = refresh().catch(() => null).finally(() => { inflight = null; });
    await inflight;
  }
  return cache ? (cache.get(id) || null) : null;
}

module.exports = { resolveById };
