/**
 * Syncs real GPS coordinates + live status from the K3I API into the local DB.
 * Invoked only by the admin sync endpoints (coordinates are locked: there is no
 * automatic refresh).
 */
const { getDb, transaction } = require('../db/database');
const k3iBridge = require('./k3iBridge');

async function syncCoordinates() {
  const cams = await k3iBridge.getCameras();
  const db = getDb();
  const update = db.prepare(`
    UPDATE cameras
    SET lat = COALESCE(?, lat), lng = COALESCE(?, lng),
        k3i_active = ?, link = COALESCE(?, link), link_type = COALESCE(?, link_type)
    WHERE id = ?
  `);

  let updated = 0, coords = 0;
  transaction(() => {
    for (const c of cams) {
      if (!c.id) continue;
      const lat = Number(c.latitude);
      const lng = Number(c.longitude);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
      const r = update.run(
        hasCoords ? lat : null,
        hasCoords ? lng : null,
        c.isActive ? 1 : 0,
        c.link || null,
        c.linkType || null,
        c.id
      );
      if (r.changes > 0) { updated += r.changes; if (hasCoords) coords++; }
    }
  });

  return { fetched: cams.length, updated, withCoords: coords };
}

module.exports = { syncCoordinates };
