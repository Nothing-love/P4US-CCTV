/**
 * Diagnosa stream: kenapa "online" tapi layar hitam?
 * Mencoba beberapa kamera, menghangatkan sesi (kunjungi situs dulu → cookie),
 * mengikuti master→media, mengambil segmen, lalu DETEKSI CODEC via ffprobe.
 *
 * Jalankan di SERVER (IP Indonesia):
 *   node backend/scripts/diagStream.js                 # auto: coba bbrp Jasa Marga
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function mergeCookie(a, b) {
  const map = new Map();
  for (const part of [a, b].filter(Boolean).join('; ').split(';')) {
    const kv = part.trim(); if (!kv) continue;
    const i = kv.indexOf('='); if (i < 0) continue;
    map.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}
function cookieOf(res) {
  const sc = res.headers['set-cookie']; if (!sc) return '';
  return (Array.isArray(sc) ? sc : [sc]).map((s) => String(s).split(';')[0]).join('; ');
}
async function get(url, cookie, responseType = 'text') {
  const origin = new URL(url).origin;
  const headers = {
    'User-Agent': UA, Referer: origin + '/', Origin: origin,
    Accept: '*/*', 'Accept-Language': 'id,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;
  return axios.get(url, { timeout: 12000, responseType, validateStatus: (s) => s < 500, maxRedirects: 5, headers });
}

// Hangatkan sesi: kunjungi root situs dulu (ambil cookie), lalu minta m3u8.
async function warmFetch(url) {
  const origin = new URL(url).origin;
  let cookie = '';
  try { const r0 = await get(origin + '/'); cookie = mergeCookie(cookie, cookieOf(r0)); } catch {}
  let r = await get(url, cookie);
  cookie = mergeCookie(cookie, cookieOf(r));
  let body = typeof r.data === 'string' ? r.data : '';
  if ((!body || body.trim() === '') && cookie) { r = await get(url, cookie); body = typeof r.data === 'string' ? r.data : ''; cookie = mergeCookie(cookie, cookieOf(r)); }
  return { res: r, cookie, body, acao: r.headers['access-control-allow-origin'] || '(tak ada)' };
}

function firstSeg(body) {
  return body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
}

async function diagOne(link, label) {
  console.log('\n──────────────────────────────────────────');
  console.log('Kamera:', label || '(url)');
  console.log('URL   :', link.slice(0, 95));
  const p = await warmFetch(link);
  const hasSeg = /#EXTINF/.test(p.body);
  const isMaster = /#EXT-X-STREAM-INF/.test(p.body);
  console.log(`[Playlist] HTTP ${p.res.status} | bytes ${p.body.length} | cookie:${p.cookie ? 'ada' : 'tidak'} | CORS(ACAO):${p.acao}`);
  console.log(`  #EXTM3U:${p.body.includes('#EXTM3U')} master:${isMaster} segmen:${hasSeg}`);
  const cm = p.body.match(/CODECS="([^"]+)"/i);
  if (cm) console.log('  CODECS(playlist):', cm[1], /hvc1|hev1/i.test(cm[1]) ? '→ H.265 (browser TAK bisa)' : '→ H.264 (OK)');

  let mediaUrl = link, mediaBody = p.body, cookie = p.cookie;
  if (isMaster && !hasSeg) {
    const lines = p.body.split('\n'); let v = null;
    for (let i = 0; i < lines.length; i++) if (/#EXT-X-STREAM-INF/.test(lines[i])) { for (let j = i + 1; j < lines.length; j++) { const t = lines[j].trim(); if (t && !t.startsWith('#')) { v = new URL(t, link).href; break; } } break; }
    if (v) { const r2 = await warmFetch(v); mediaUrl = v; mediaBody = r2.body; cookie = mergeCookie(cookie, r2.cookie); console.log('  varian:', v.slice(0, 80), '| segmen:', /#EXTINF/.test(mediaBody)); }
  }
  const seg = firstSeg(mediaBody);
  if (!seg) { console.log('  → playlist kosong/ tanpa segmen (kamera ini mati/tak keluar video).'); return false; }

  const segUrl = new URL(seg, mediaUrl).href;
  const sr = await get(segUrl, cookie, 'arraybuffer');
  console.log(`[Segmen] HTTP ${sr.status} | bytes ${(sr.data && sr.data.length) || 0}`);
  if (sr.status !== 200 || !sr.data || !sr.data.length) { console.log('  → segmen tak terambil.'); return false; }

  const tmp = path.join(os.tmpdir(), 'p4us-diag-seg.ts');
  fs.writeFileSync(tmp, Buffer.from(sr.data));
  const ffprobe = config.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, e) => 'ffprobe' + (e || ''));
  const pr = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'default=nw=1', tmp], { encoding: 'utf8', timeout: 15000 });
  try { fs.unlinkSync(tmp); } catch {}
  const out = (pr.stdout || '').trim();
  console.log('[ffprobe]', out || (pr.error ? 'gagal: ' + pr.error.message : (pr.stderr || '(kosong)').trim()));
  const codec = (out.match(/codec_name=(\w+)/) || [])[1] || '';
  console.log('[HASIL]', /hevc|h265/i.test(codec) ? 'H.265/HEVC → browser HITAM → WAJIB transcode FFmpeg.'
    : /h264|avc/i.test(codec) ? 'H.264 → browser OK (kalau masih hitam, isu lain).' : 'codec: ' + (codec || '(tak terbaca)'));
  return true;
}

(async () => {
  initDatabase();
  const arg = process.argv[2];
  const db = getDb();
  let cams = [];
  if (arg && /^https?:/i.test(arg)) cams = [{ name: '(url)', link: arg }];
  else if (arg) {
    let c = db.prepare('SELECT name, link FROM cameras WHERE id = ?').get(arg)
         || db.prepare('SELECT name, link FROM cameras WHERE name LIKE ? LIMIT 1').get('%' + arg + '%');
    if (c) cams = [c];
  }
  if (!cams.length) cams = db.prepare("SELECT name, link FROM cameras WHERE host='jmlive.jasamarga.com' AND link_type='M3U8' LIMIT 8").all();
  if (!cams.length) { console.log('Tak ada kamera.'); process.exit(1); }

  console.log('=== DIAGNOSA STREAM (' + cams.length + ' kandidat) ===');
  let okCam = false;
  for (const c of cams) {
    try { if (await diagOne(c.link, c.name)) { okCam = true; break; } } catch (e) { console.log('  ERR', e.message); }
  }
  console.log('\n==========================================');
  if (!okCam) console.log('KESIMPULAN: semua kandidat balas KOSONG walau sudah pakai cookie + hangatkan sesi.');
  else console.log('KESIMPULAN: lihat baris [HASIL] di atas untuk codec kamera yang aktif.');
})().catch((e) => console.error('ERR', e.message));
