/**
 * Reset status 'DEAD' yang basi → 'UNKNOWN'.
 * Dipakai setelah perbaikan logika health-check: kamera yang terlanjur ditandai
 * DEAD (sebelum perbaikan, atau karena gangguan sesaat) dikembalikan ke UNKNOWN
 * supaya statusnya segera ikut katalog (k3i_active / access_class), lalu
 * health-checker memverifikasi ulang (siklus ~25 menit).
 *
 * Aman dijalankan kapan saja. Jalankan:  node backend/scripts/resetHealth.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { initDatabase, getDb } = require('../db/database');

function run() {
  initDatabase();
  const db = getDb();
  const before = db.prepare("SELECT COUNT(*) c FROM cameras WHERE health_status = 'DEAD'").get().c;
  const r = db.prepare(
    "UPDATE cameras SET health_status = 'UNKNOWN', health_latency_ms = NULL WHERE health_status = 'DEAD'"
  ).run();
  console.log(`Reset ${r.changes} kamera DEAD → UNKNOWN (sebelumnya ${before}).`);
  console.log('Status kini mengikuti katalog; health-checker memverifikasi ulang (~25 menit).');
}

run();
