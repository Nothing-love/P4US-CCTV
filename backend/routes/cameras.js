const express = require('express');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/authMiddleware');
const { checkStreamHealth } = require('../services/streamProxy');

const router = express.Router();

/**
 * Derived stream status, combining real-time health with the catalog probe:
 *   online  – currently reachable / known-working
 *   offline – confirmed dead / unreachable
 *   unknown – needs credentials or not yet checked
 */
const STATUS_SQL = `
  CASE
    WHEN health_status IN ('LIVE','SLOW') THEN 'online'
    WHEN health_status = 'DEAD' THEN 'offline'
    WHEN k3i_active = 1 THEN 'online'
    WHEN k3i_active = 0 THEN 'offline'
    WHEN access_class IN ('OFFLINE','UNREACHABLE','HOST_ERROR','NOT_A_STREAM') THEN 'offline'
    WHEN access_class IN ('OPEN_NO_AUTH','CRED_REQUIRED_CRED_IN_CATALOG') THEN 'online'
    ELSE 'unknown'
  END`;

// GET /api/cameras  — list with filters (category, status, province, search)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const {
    province, host, category, status, access_class, search,
    limit = 500, offset = 0
  } = req.query;

  const conditions = [];
  const params = [];

  if (province && province !== 'ALL') { conditions.push('province_code = ?'); params.push(province); }
  if (host)         { conditions.push('host = ?'); params.push(host); }
  if (category)     { conditions.push('category = ?'); params.push(category); }
  if (access_class) { conditions.push('access_class = ?'); params.push(access_class); }
  if (search)       { conditions.push('(name LIKE ? OR owner LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && ['online', 'offline', 'unknown'].includes(status)) {
    conditions.push(`(${STATUS_SQL}) = ?`); params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const cameras = db.prepare(`
    SELECT id, name, type, link_type, scheme, host, owner, access_class, category,
           province_code, province_name, lat, lng, k3i_active,
           health_status, health_latency_ms, ptz_capable, ptz_type, group_name,
           ${STATUS_SQL} as stream_status
    FROM cameras ${where}
    ORDER BY province_name, name
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit, 10), parseInt(offset, 10));

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM cameras ${where}`).get(...params).cnt;

  res.json({ cameras, total, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
});

// GET /api/cameras/stats  — accurate overall online/offline totals (all 5237)
router.get('/stats', authenticate, (req, res) => {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN (${STATUS_SQL}) = 'online'  THEN 1 ELSE 0 END) as online,
      SUM(CASE WHEN (${STATUS_SQL}) = 'offline' THEN 1 ELSE 0 END) as offline,
      SUM(CASE WHEN (${STATUS_SQL}) = 'unknown' THEN 1 ELSE 0 END) as unknown
    FROM cameras
  `).get();
  res.json(row);
});

// GET /api/cameras/health  — recent health status for all cameras
router.get('/health', authenticate, (req, res) => {
  const health = getDb().prepare(`
    SELECT id, health_status, health_latency_ms, last_checked
    FROM cameras
    WHERE last_checked IS NOT NULL
  `).all();
  res.json({ health });
});

// POST /api/cameras/health/recheck — probe ulang kamera tertentu SEKARANG.
// Body: { ids: [...] } (maks 50). Dipakai tombol "Refresh" supaya status
// online/offline kamera yang sedang dilihat langsung akurat tanpa menunggu
// siklus pemeriksaan latar (30 detik).
router.post('/health/recheck', authenticate, async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.filter(x => typeof x === 'string'))].slice(0, 50)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'ids (1-50) wajib diisi' });

  const db = getDb();
  const ph = ids.map(() => '?').join(',');
  const cams = db.prepare(
    `SELECT id, link, link_type FROM cameras WHERE id IN (${ph})`
  ).all(...ids);

  // Jangan turunkan ke DEAD kamera yang <5 menit lalu terbukti tampil di klien.
  const update = db.prepare(`
    UPDATE cameras SET health_status = CASE
          WHEN ? = 'DEAD' AND client_alive_at IS NOT NULL AND (unixepoch() - client_alive_at) < 300
          THEN health_status ELSE ? END,
        health_latency_ms = ?, last_checked = unixepoch()
    WHERE id = ?`);

  await Promise.allSettled(cams.map(async (cam) => {
    const { status, latencyMs } = await checkStreamHealth(cam.link, cam.link_type);
    update.run(status, status, latencyMs, cam.id);
  }));

  const updated = db.prepare(
    `SELECT id, health_status, health_latency_ms, (${STATUS_SQL}) as stream_status
     FROM cameras WHERE id IN (${ph})`
  ).all(...ids);
  res.json({ rechecked: cams.length, updated });
});

// POST /api/cameras/:id/alive  — stream berhasil diputar klien → tandai LIVE.
// Sumber status paling akurat: kamera yang benar-benar tampil di grid.
router.post('/:id/alive', authenticate, (req, res) => {
  const r = getDb().prepare(
    "UPDATE cameras SET health_status = 'LIVE', last_checked = unixepoch(), client_alive_at = unixepoch() WHERE id = ?"
  ).run(req.params.id);
  res.json({ updated: r.changes > 0 });
});

// GET /api/cameras/:id
router.get('/:id', authenticate, (req, res) => {
  const camera = getDb().prepare(`
    SELECT id, name, type, link_type, scheme, host, owner, access_class,
           link, province_code, province_name, lat, lng,
           health_status, health_latency_ms, last_checked,
           ptz_capable, ptz_type, group_name
    FROM cameras WHERE id = ?
  `).get(req.params.id);

  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  res.json({ camera });
});

// ─── User slot management ─────────────────────────────────────────────────

// GET /api/cameras/slots/me
router.get('/slots/me', authenticate, (req, res) => {
  const slots = getDb().prepare(`
    SELECT s.slot, c.id, c.name, c.link_type, c.host, c.owner,
           c.province_name, c.health_status, c.ptz_capable, c.access_class
    FROM user_camera_slots s
    JOIN cameras c ON c.id = s.camera_id
    WHERE s.user_id = ?
    ORDER BY s.slot
  `).all(req.user.id);
  res.json({ slots });
});

// PUT /api/cameras/slots/:slot
router.put('/slots/:slot', authenticate, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot < 1 || slot > 8) return res.status(400).json({ error: 'Slot must be 1-8' });

  const { cameraId } = req.body;
  const db = getDb();

  if (!cameraId) {
    db.prepare('DELETE FROM user_camera_slots WHERE user_id = ? AND slot = ?').run(req.user.id, slot);
    return res.json({ message: 'Slot cleared' });
  }

  const cam = db.prepare('SELECT id FROM cameras WHERE id = ?').get(cameraId);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  db.prepare(`
    INSERT OR REPLACE INTO user_camera_slots (user_id, camera_id, slot)
    VALUES (?, ?, ?)
  `).run(req.user.id, cameraId, slot);

  res.json({ message: 'Slot updated', slot, cameraId });
});

// DELETE /api/cameras/slots/:slot
router.delete('/slots/:slot', authenticate, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  getDb().prepare('DELETE FROM user_camera_slots WHERE user_id = ? AND slot = ?').run(req.user.id, slot);
  res.json({ message: 'Slot cleared' });
});

module.exports = router;
