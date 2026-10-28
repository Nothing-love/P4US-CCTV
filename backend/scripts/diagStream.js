/**
 * Diagnosa stream: kenapa "online" tapi layar hitam?
 * Menelusuri playlist (dengan cookie sesi), mengikuti master→media, mengambil
 * segmen pertama, dan MENDETEKSI CODEC sebenarnya via ffprobe.
 *
 * Jalankan di SERVER (IP Indonesia):
 *   node backend/scripts/diagStream.js                 # auto: kamera Jasa Marga
 *   node backend/scripts/diagStream.js <id|nama|url>   # kamera tertentu
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');
const { initDatabase, getDb } = require('../db/database');

const UA = 'Mozilla/5.0 (compatible; P4US-CCTV/1.0)';

async function get(url, cookie, responseType = 'text') {
  const origin = new URL(url).origin;
  const headers = { 'User-Agent': UA, Referer: origin + '/' };
  if (cookie) headers.Cookie = cookie;
  return axios.get(url, { timeout: 12000, responseType, validateStatus: (s) => s < 500, maxRedirects: 3, headers });
}
function cookieOf(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return '';
  return (Array.isArray(sc) ? sc : [sc]).map((s) => String(s).split(';')[0]).join('; ');
}
async function fetchPlaylist(url) {
  let r = await get(url);
  let cookie = cookieOf(r);
  const empty = !r.data || String(r.data).trim() === '';
  if (empty && cookie) r = await get(url, cookie);   // warm-up dengan cookie
  return { res: r, cookie, body: typeof r.data === 'string' ? r.data : '' };
}

(async () => {
  initDatabase();
  const arg = process.argv[2];
  let link = arg, label = '';
  if (!arg || !/^https?:/i.test(arg)) {
    const db = getDb();
    let cam = arg ? db.prepare('SELECT name, link FROM cameras WHERE id = ?').get(arg) : null;
    if (!cam && arg) cam = db.prepare('SELECT name, link FROM cameras WHERE name LIKE ? OR host LIKE ? LIMIT 1').get('%' + arg + '%', '%' + arg + '%');
    if (!cam) cam = db.prepare("SELECT name, link FROM cameras WHERE host = 'jmlive.jasamarga.com' AND link_type='M3U8' LIMIT 1").get();
    if (!cam) { console.log('Kamera tidak ditemukan.'); process.exit(1); }
    link = cam.link; label = cam.name;
  }
  console.log('=== DIAGNOSA STREAM ===');
  console.log('Kamera:', label || '(url langsung)');
  console.log('URL   :', link, '\n');

  const p = await fetchPlaylist(link);
  console.log('[Playlist] HTTP', p.res.status, '| bytes', p.body.length, '| butuh cookie:', p.cookie ? 'YA' : 'tidak');
  console.log('  #EXTM3U:', p.body.includes('#EXTM3U'), '| master:', /#EXT-X-STREAM-INF/.test(p.body), '| ada segmen:', /#EXTINF/.test(p.body));
  const cm = p.body.match(/CODECS="([^"]+)"/i);
  if (cm) console.log('  CODECS (dari playlist):', cm[1], /hvc1|hev1/i.test(cm[1]) ? '→ H.265/HEVC (browser TAK bisa decode)' : '→ H.264 (browser OK)');

  // ikuti master → media
  let mediaUrl = link, mediaBody = p.body, cookie = p.cookie;
  if (/#EXT-X-STREAM-INF/.test(p.body)) {
    const lines = p.body.split('\n'); let v = null;
    for (let i = 0; i < lines.length; i++) {
      if (/#EXT-X-STREAM-INF/.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) { const t = lines[j].trim(); if (t && !t.startsWith('#')) { v = new URL(t, link).href; break; } }
        break;
      }
    }
    if (v) { const r2 = await fetchPlaylist(v); mediaUrl = v; mediaBody = r2.body; cookie = r2.cookie || cookie; console.log('  → varian:', v.slice(0, 80), '| ada segmen:', /#EXTINF/.test(mediaBody)); }
  }

  const segLine = mediaBody.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!segLine) { console.log('\n[HASIL] Playlist TANPA segmen → stream tak mengeluarkan video (mati/kosong).'); process.exit(0); }
  const segUrl = new URL(segLine, mediaUrl).href;
  const sr = await get(segUrl, cookie, 'arraybuffer');
  console.log('\n[Segmen] HTTP', sr.status, '| bytes', (sr.data && sr.data.length) || 0);
  if (sr.status !== 200 || !sr.data || !sr.data.length) { console.log('[HASIL] Segmen tak terambil → tak ada gambar.'); process.exit(0); }

  // ffprobe codec sebenarnya
  const tmp = path.join(os.tmpdir(), 'p4us-diag-seg.ts');
  fs.writeFileSync(tmp, Buffer.from(sr.data));
  const ffprobe = config.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, e) => 'ffprobe' + (e || ''));
  const pr = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'default=nw=1', tmp], { encoding: 'utf8', timeout: 15000 });
  try { fs.unlinkSync(tmp); } catch {}
  const out = (pr.stdout || '').trim();
  console.log('[ffprobe]', out || (pr.error ? 'gagal: ' + pr.error.message : (pr.stderr || '(tak ada output)').trim()));
  const codec = (out.match(/codec_name=(\w+)/) || [])[1] || '';
  console.log('\n[HASIL]');
  if (/hevc|h265/i.test(codec)) console.log('  Codec H.265/HEVC → browser TAK bisa decode → HITAM. Solusi: WAJIB transcode FFmpeg.');
  else if (/h264|avc/i.test(codec)) console.log('  Codec H.264 → browser OK. Kalau masih hitam: cek cookie/segmen/mixed-content.');
  else console.log('  Codec:', codec || '(tak terbaca)');
})().catch((e) => console.error('ERR', e.message));
