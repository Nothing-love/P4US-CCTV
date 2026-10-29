const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

let db;

function initDatabase() {
  db = new DatabaseSync(path.join(__dirname, 'p4us.db'));
  // busy_timeout DULU: bila proses lain (mis. importer berjalan bersamaan)
  // sedang menulis, operasi ini MENUNGGU sampai 15 dtk alih-alih langsung
  // gagal "database is locked" (SQLITE_BUSY) yang bikin server crash saat start.
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('superadmin','admin','viewer')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_token TEXT,
      reset_token TEXT,
      reset_token_expires INTEGER,
      last_login INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      link_type TEXT,
      scheme TEXT,
      host TEXT,
      owner TEXT,
      has_token INTEGER DEFAULT 0,
      has_cred INTEGER DEFAULT 0,
      access_class TEXT,
      link TEXT NOT NULL,
      province_code TEXT,
      province_name TEXT,
      lat REAL,
      lng REAL,
      last_checked INTEGER,
      health_status TEXT DEFAULT 'UNKNOWN',
      health_latency_ms INTEGER,
      ptz_capable INTEGER DEFAULT 0,
      ptz_type TEXT,
      credentials TEXT,
      group_name TEXT,
      category TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_cam_province ON cameras(province_code);
    CREATE INDEX IF NOT EXISTS idx_cam_host ON cameras(host);
    CREATE INDEX IF NOT EXISTS idx_cam_access ON cameras(access_class);
    CREATE INDEX IF NOT EXISTS idx_cam_health ON cameras(health_status);

    CREATE TABLE IF NOT EXISTS user_camera_slots (
      user_id TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 8),
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, slot),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      camera_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      file_size INTEGER,
      duration_sec INTEGER,
      status TEXT NOT NULL DEFAULT 'recording' CHECK(status IN ('recording','completed','failed')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migration: add category + K3I active-status columns to pre-existing databases
  try { db.exec('ALTER TABLE cameras ADD COLUMN category TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE cameras ADD COLUMN k3i_active INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE cameras ADD COLUMN client_alive_at INTEGER'); } catch { /* already exists */ }
  // Migration: endpoint cadangan (failover) + jenis endpoint (stream/still/frame/youtube)
  try { db.exec('ALTER TABLE cameras ADD COLUMN backup_link TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE cameras ADD COLUMN backup_link_type TEXT'); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE cameras ADD COLUMN endpoint_kind TEXT DEFAULT 'stream'"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE cameras ADD COLUMN refresh_sec INTEGER'); } catch { /* already exists */ }
  // Migration: ruas identifier for jmlive UUID resolver (trafik.live API param "r")
  try { db.exec('ALTER TABLE cameras ADD COLUMN jm_ruas TEXT'); } catch { /* already exists */ }

  // Migration: widen the slot range from 1-6 to 1-8 (grid now supports 8).
  const slotSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='user_camera_slots'").get();
  if (slotSchema && slotSchema.sql.includes('BETWEEN 1 AND 6')) {
    db.exec(`
      CREATE TABLE user_camera_slots_v2 (
        user_id TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 8),
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, slot),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
      );
      INSERT INTO user_camera_slots_v2 SELECT * FROM user_camera_slots;
      DROP TABLE user_camera_slots;
      ALTER TABLE user_camera_slots_v2 RENAME TO user_camera_slots;
    `);
  }

  // (Re)compute camera categories from owner so the sidebar can group by
  // instansi (Korlantas / Jasa Marga / Pemda / IP langsung) instead of host.
  db.exec(`
    UPDATE cameras SET category = CASE
      WHEN host = 'cctv.balitower.co.id' OR owner LIKE '%Bali Tower%' THEN 'Bali Tower (Jakarta)'
      WHEN owner LIKE '%Korlantas%' THEN 'Korlantas'
      WHEN owner LIKE '%Jasa Marga%' THEN 'Jasa Marga'
      WHEN owner LIKE '%Dishub%' OR owner LIKE '%Pemda%' OR owner LIKE '%.go.id%'
           OR host LIKE '%.go.id%' THEN 'Pemda / Dishub'
      WHEN owner LIKE '%IP langsung%' OR owner LIKE '%ISP%' OR owner LIKE '%polda%' THEN 'Kamera IP (Polda/ISP)'
      ELSE 'Lainnya'
    END
  `);

  // Detect PTZ-capable cameras (direct-IP RTSP devices named "PTZ") and infer
  // the control protocol from the RTSP path. Aggregated HLS feeds aren't PTZ.
  db.exec(`
    UPDATE cameras SET
      ptz_capable = CASE
        WHEN link_type = 'RTSP' AND UPPER(name) LIKE '%PTZ%' THEN 1 ELSE 0 END,
      ptz_type = CASE
        WHEN link LIKE '%Streaming/Channels%' OR link LIKE '%/ISAPI/%' THEN 'hikvision'
        WHEN link LIKE '%cam/realmonitor%' OR link LIKE '%cgi-bin%' THEN 'dahua'
        ELSE ptz_type END
  `);

  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (count === 0) {
    const rawPw = config.admin.password || generateSecurePassword();
    const hash = bcrypt.hashSync(rawPw, 12);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status, email_verified)
      VALUES (?, ?, ?, 'Super Admin', 'superadmin', 'active', 1)
    `).run(uuidv4(), config.admin.email, hash);

    if (!config.admin.password) {
      console.log('\n══════════════════════════════════════════');
      console.log(' P4US CCTV — Default Admin Created');
      console.log(` Email   : ${config.admin.email}`);
      console.log(` Password: ${rawPw}`);
      console.log(' Change this password immediately!');
      console.log('══════════════════════════════════════════\n');
    }
  } else if (config.admin.password) {
    // ADMIN_PASSWORD di .env bersifat otoritatif: samakan password superadmin
    // dengan nilai .env pada setiap start (bisa diubah kapan saja via .env).
    const admin = db.prepare("SELECT id, password_hash FROM users WHERE email = ? AND role = 'superadmin'")
      .get(config.admin.email);
    if (admin && !bcrypt.compareSync(config.admin.password, admin.password_hash)) {
      const hash = bcrypt.hashSync(config.admin.password, 12);
      db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, updated_at = unixepoch() WHERE id = ?")
        .run(hash, admin.id);
      console.log('P4US CCTV — password superadmin disinkron dari .env (ADMIN_PASSWORD).');
    }
  }

  return db;
}

function generateSecurePassword() {
  const charset = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789@#$%&!';
  return Array.from({ length: 16 }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// Transaction helper (node:sqlite does not have db.transaction(), use manual BEGIN/COMMIT)
function transaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { initDatabase, getDb, transaction };
