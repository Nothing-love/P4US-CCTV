/**
 * Background health checker.
 * Checks a batch of cameras every interval, cycling through all cameras.
 */
const { getDb } = require('../db/database');
const { checkStreamHealth } = require('./streamProxy');

// Batch besar supaya seluruh kamera (ribuan) tercek ulang dalam ~25 menit,
// bukan ~80+ menit. Status jadi lebih cepat akurat (tak lama "basi").
const BATCH_SIZE = 100;
const INTERVAL_MS = 30_000;

let offset = 0;
let timer = null;

async function checkBatch() {
  let db;
  try { db = getDb(); } catch { return; } // DB not ready yet

  // Cek kamera HLS/M3U8 (fetch playlist) DAN RTSP (cek TCP keterjangkauan).
  // Kredensial, bila ada, sudah menyatu di link. RTSP memakai cek TCP ringan
  // (checkStreamHealth → checkRtspReachable) supaya status online/offline NYATA,
  // bukan selalu UNKNOWN. INTERNAL_PRIVATE tetap dilewati (host privat yang,
  // dari luar jaringan server, memang tak terjangkau — cegah vonis DEAD massal).
  const cameras = db.prepare(`
    SELECT id, link, link_type FROM cameras
    WHERE link_type IN ('M3U8','HLS','RTSP')
      AND access_class NOT IN ('NOT_A_STREAM','INTERNAL_PRIVATE')
    ORDER BY id
    LIMIT ? OFFSET ?
  `).all(BATCH_SIZE, offset);

  if (cameras.length === 0) {
    offset = 0;
    return;
  }

  // Jangan turunkan ke DEAD kamera yang <5 menit lalu terbukti tampil di klien
  // (pemutaran browser = sumber kebenaran). Status LIVE/SLOW tetap diterapkan.
  const update = db.prepare(`
    UPDATE cameras
    SET health_status = CASE
          WHEN ? = 'DEAD' AND client_alive_at IS NOT NULL AND (unixepoch() - client_alive_at) < 300
          THEN health_status ELSE ? END,
        health_latency_ms = ?, last_checked = unixepoch()
    WHERE id = ?
  `);

  const results = await Promise.allSettled(
    cameras.map(async (cam) => {
      const { status, latencyMs } = await checkStreamHealth(cam.link, cam.link_type);
      update.run(status, status, latencyMs, cam.id);
    })
  );

  offset += BATCH_SIZE;

  const errors = results.filter(r => r.status === 'rejected').length;
  if (errors > 0) console.warn(`HealthChecker: ${errors} checks failed in this batch`);
}

function startHealthChecker() {
  if (timer) return;
  // Stagger first check by 5s to let DB init finish
  setTimeout(() => {
    checkBatch().catch(console.error);
    timer = setInterval(() => checkBatch().catch(console.error), INTERVAL_MS);
  }, 5000);
}

module.exports = { startHealthChecker };
