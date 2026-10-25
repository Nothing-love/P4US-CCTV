/**
 * Background health checker.
 * Checks a batch of cameras every interval, cycling through all cameras.
 */
const { getDb } = require('../db/database');
const { checkStreamHealth } = require('./streamProxy');

const BATCH_SIZE = 30;
const INTERVAL_MS = 30_000;

let offset = 0;
let timer = null;

async function checkBatch() {
  let db;
  try { db = getDb(); } catch { return; } // DB not ready yet

  // Check all HLS/M3U8 cameras (the browser-playable ones). Embedded
  // credentials, if any, are already part of the link.
  const cameras = db.prepare(`
    SELECT id, link, link_type FROM cameras
    WHERE link_type IN ('M3U8','HLS')
      AND access_class NOT IN ('NOT_A_STREAM','INTERNAL_PRIVATE')
    ORDER BY id
    LIMIT ? OFFSET ?
  `).all(BATCH_SIZE, offset);

  if (cameras.length === 0) {
    offset = 0;
    return;
  }

  const update = db.prepare(`
    UPDATE cameras
    SET health_status = ?, health_latency_ms = ?, last_checked = unixepoch()
    WHERE id = ?
  `);

  const results = await Promise.allSettled(
    cameras.map(async (cam) => {
      const { status, latencyMs } = await checkStreamHealth(cam.link, cam.link_type);
      update.run(status, latencyMs, cam.id);
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

function stopHealthChecker() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { startHealthChecker, stopHealthChecker };
