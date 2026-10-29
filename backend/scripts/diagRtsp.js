/**
 * Diagnosa RTSP end-to-end (JALANKAN DI SERVER).
 * Untuk tiap kamera RTSP: (1) TCP terjangkau?, (2) codec+pix_fmt, (3) ffmpeg
 * benar-benar menarik 3 dtk & menghasilkan segmen (bukti keluar gambar).
 * Menjawab "kenapa hitam": tak terjangkau, atau codec, atau kredensial/path.
 *
 * Jalankan:
 *   node backend/scripts/diagRtsp.js "Kejora"     # kamera tertentu (cocok nama)
 *   node backend/scripts/diagRtsp.js              # 12 kamera RTSP pertama
 *   node backend/scripts/diagRtsp.js --live       # hanya yg health LIVE
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { initDatabase, getDb } = require('../db/database');
const transcoder = require('../services/rtspTranscoder');
const config = require('../config');

const arg = process.argv[2];

function tcpCheck(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const s = new net.Socket(); const t0 = Date.now(); let done = false;
    const fin = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok ? Date.now() - t0 : -1); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch { fin(false); }
  });
}

// Jalankan ffmpeg 3 dtk sesuai keputusan copy/encode; kembalikan jumlah segmen.
function tryTranscode(link, encode) {
  return new Promise((resolve) => {
    const dir = path.join(os.tmpdir(), 'p4us-diag-' + Date.now() + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(dir, { recursive: true });
    // Opsi socket-timeout sesuai versi FFmpeg (sama seperti transcoder asli).
    const args = ['-rtsp_transport', 'tcp', ...transcoder.rtspTimeoutArgs(8000000), '-i', link, '-an', '-t', '3'];
    if (encode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50');
    else args.push('-c:v', 'copy');
    args.push('-f', 'hls', '-hls_time', '2', '-hls_segment_filename', path.join(dir, 's_%03d.ts'), path.join(dir, 'i.m3u8'));
    const p = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 12000);
    p.on('exit', () => {
      clearTimeout(kill);
      let segs = 0;
      try { segs = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).length; } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const reason = segs ? '' : (/401|unauthor/i.test(err) ? 'AUTH' : /refused|timed|-138|failed/i.test(err) ? 'TAK TERJANGKAU' : /not found|404|invalid data/i.test(err) ? 'PATH/DATA' : 'lihat stderr');
      resolve({ segs, reason });
    });
  });
}

(async () => {
  initDatabase();
  const db = getDb();
  const n = (arg && /^\d+$/.test(arg)) ? parseInt(arg, 10) : null;
  let cams;
  if (n) {
    cams = db.prepare("SELECT id,name,link,health_status FROM cameras WHERE link_type='RTSP' ORDER BY RANDOM() LIMIT ?").all(n);
  } else if (arg && arg !== '--live') {
    cams = db.prepare("SELECT id,name,link,health_status FROM cameras WHERE link_type='RTSP' AND name LIKE ? LIMIT 6").all('%' + arg + '%');
  } else if (arg === '--live') {
    cams = db.prepare("SELECT id,name,link,health_status FROM cameras WHERE link_type='RTSP' AND health_status IN ('LIVE','SLOW') LIMIT 20").all();
  } else {
    cams = db.prepare("SELECT id,name,link,health_status FROM cameras WHERE link_type='RTSP' LIMIT 12").all();
  }
  if (!cams.length) { console.log('Tak ada kamera RTSP cocok.'); process.exit(0); }

  console.log(`Menguji ${cams.length} kamera RTSP (FFmpeg major ${transcoder.getFfmpegMajor()})...\n`);
  console.log('NAMA'.padEnd(34), 'TCP'.padEnd(8), 'CODEC'.padEnd(12), 'FFMPEG');
  console.log('-'.repeat(78));
  const tally = { ok: 0, auth: 0, mati: 0, lain: 0 };
  for (const c of cams) {
    let host, port;
    try { const u = new URL(c.link); host = u.hostname; port = u.port ? +u.port : 554; } catch { host = '?'; port = 0; }
    const ms = await tcpCheck(host, port);
    const tcp = ms >= 0 ? `${ms}ms` : 'MATI';
    let codecStr = '-', ff = 'dilewati (TCP mati)';
    if (ms < 0) { tally.mati++; }
    else {
      const pr = transcoder.probeVideoCodec(c.link, { rtsp: true });
      codecStr = `${pr.codec || '?'}/${pr.pixFmt || '?'}`;
      if (pr.authFailed) { ff = 'GAGAL (AUTH 401)'; tally.auth++; }
      else {
        const r = await tryTranscode(c.link, !pr.playable);
        if (r.segs) { ff = `OK ${r.segs} segmen → GAMBAR`; tally.ok++; }
        else { ff = `GAGAL (${r.reason})`; if (r.reason === 'AUTH') tally.auth++; else tally.lain++; }
      }
    }
    console.log(c.name.slice(0, 33).padEnd(34), tcp.padEnd(8), codecStr.padEnd(12), ff);
  }
  const tot = cams.length;
  const pct = (x) => `${x} (${Math.round(x / tot * 100)}%)`;
  console.log('\n=== RINGKASAN (' + tot + ' kamera) ===');
  console.log('  ✅ KELUAR GAMBAR         :', pct(tally.ok));
  console.log('  🔑 401 kredensial/channel:', pct(tally.auth), '→ perbaiki user/sandi atau channel di katalog');
  console.log('  📵 TAK TERJANGKAU        :', pct(tally.mati), '→ IP privat (server perlu sejaringan) / kamera mati');
  console.log('  ❓ gagal lain            :', pct(tally.lain));
  console.log('\nKode transcode SAMA untuk semua; hasil beda karena DATA/JARINGAN tiap kamera.');
  process.exit(0);
})();
