/**
 * Diagnosa VERBOSE transcode RTSP (JALANKAN DI SERVER).
 * Menunjukkan versi FFmpeg/ffprobe, path yang dipakai, lalu menjalankan jalur
 * transcode PERSIS seperti aplikasi untuk satu kamera + DUMP stderr ffmpeg,
 * agar ketahuan kenapa di server masih "menyiapkan stream" padahal di dev jalan.
 *
 * Jalankan:  node backend/scripts/diagRtspVerbose.js "SIMPANG 3 BATAAN"
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { initDatabase, getDb } = require('../db/database');
const transcoder = require('../services/rtspTranscoder');
const config = require('../config');

const mask = (s) => String(s).replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@');
const ffprobePath = config.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const arg = process.argv[2] || 'SIMPANG 3 BATAAN';

function ver(bin) {
  try { const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000 });
    return (r.stdout || r.stderr || '').split('\n')[0] || `exit ${r.status}`; }
  catch (e) { return 'TIDAK ADA / error: ' + (e.code || e.message); }
}

(async () => {
  console.log('=== LINGKUNGAN FFMPEG ===');
  console.log('config.ffmpegPath :', config.ffmpegPath);
  console.log('ffprobe (turunan) :', ffprobePath);
  console.log('ffmpeg -version   :', ver(config.ffmpegPath));
  console.log('ffprobe -version  :', ver(ffprobePath));

  initDatabase();
  const cam = getDb().prepare("SELECT id,name,link FROM cameras WHERE link_type='RTSP' AND name LIKE ? LIMIT 1").get('%' + arg + '%');
  if (!cam) { console.log('\nKamera tak ditemukan:', arg); process.exit(1); }
  console.log('\n=== KAMERA ===');
  console.log('nama:', cam.name);
  console.log('url :', mask(cam.link));

  console.log('\n=== PROBE (probeVideoCodec) ===');
  const p = transcoder.probeVideoCodec(cam.link, { rtsp: true });
  console.log(JSON.stringify(p));

  console.log('\n=== TRANSCODE 4 dtk (args PERSIS aplikasi) + STDERR ffmpeg ===');
  const encode = !p.playable;
  console.log('keputusan: encode =', encode);
  const dir = path.join(os.tmpdir(), 'p4us-diagv-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-rtsp_transport', 'tcp', '-timeout', '6000000',
    '-fflags', '+discardcorrupt', '-err_detect', 'ignore_err', '-i', cam.link, '-an'];
  if (encode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50');
  else args.push('-c:v', 'copy');
  args.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'), path.join(dir, 'index.m3u8'));

  const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 15000);
  proc.on('exit', (code) => {
    clearTimeout(t);
    const segs = (() => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).length; } catch { return 0; } })();
    const playlist = fs.existsSync(path.join(dir, 'index.m3u8'));
    console.log('\nffmpeg exit:', code, '| playlist:', playlist, '| segmen .ts:', segs);
    console.log('--- stderr ffmpeg (ekor) ---');
    console.log(mask(err.split('\n').slice(-25).join('\n')));
    console.log('\n=== KESIMPULAN ===');
    if (segs > 0) console.log('ffmpeg KELUAR segmen di server → transcode OK. Masalah mungkin cache browser/frontend (hard-refresh Ctrl+Shift+R).');
    else console.log('ffmpeg TIDAK keluar segmen → lihat stderr di atas (versi ffmpeg? opsi tak didukung? koneksi?).');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
