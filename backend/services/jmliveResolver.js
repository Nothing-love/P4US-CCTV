/**
 * Resolver URL HLS jmlive (Jasa Marga Live).
 *
 * UUID stream jmlive.jasamarga.com BERPUTAR — URL di katalog cepat basi.
 * Resolver ini memanggil API trafik.live untuk mendapat UUID terkini,
 * lalu menyimpannya di cache sesuai TTL dari field `age` respons.
 *
 * Endpoint: GET https://trafik.live/api/jmlive?r=<ruas>&n=<nama>&v=Kamera
 * Respons:  { "hls": "https://jmlive.jasamarga.com/hls/<ch>/<uuid>/index.m3u8",
 *             "cap": "...", "at": "...", "age": <detik> }
 */
const axios = require('axios');

const API_URL = 'https://trafik.live/api/jmlive';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Cache: key "ruas|nama" → { hls, expires (ms epoch) }
const cache = new Map();

/**
 * Kembalikan URL HLS terkini untuk kamera jmlive.
 * @param {string} ruas  - id_ruas (mis. "dalam-kota", "jakarta-cikampek")
 * @param {string} nama  - nama kamera persis seperti di trafik.live
 * @param {string} [view='Kamera'] - tipe tampilan
 * @returns {Promise<string|null>}  URL HLS segar, atau null bila gagal
 */
async function resolveJmlive(ruas, nama, view = 'Kamera') {
  if (!ruas || !nama) return null;

  const key = `${ruas}|${nama}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.hls;

  try {
    const url = new URL(API_URL);
    url.searchParams.set('r', ruas);
    url.searchParams.set('n', nama);
    url.searchParams.set('v', view);

    const r = await axios.get(url.toString(), {
      timeout: 8000,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://trafik.live/',
        'Accept': 'application/json, */*',
      },
      validateStatus: (s) => s < 500,
    });

    if (r.status === 200 && r.data?.hls && typeof r.data.hls === 'string') {
      const age = typeof r.data.age === 'number' ? r.data.age : 120;
      // Refresh pada 80% TTL agar tidak pernah sajikan URL kedaluwarsa.
      cache.set(key, { hls: r.data.hls, expires: Date.now() + age * 800 });
      return r.data.hls;
    }
  } catch { /* jika gagal, kembalikan null — pakai URL katalog sebagai fallback */ }

  return null;
}

/**
 * Hapus satu entri cache (dipanggil bila stream ternyata masih mati).
 */
function invalidate(ruas, nama) {
  cache.delete(`${ruas}|${nama}`);
}

module.exports = { resolveJmlive, invalidate };
