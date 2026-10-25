const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { authenticate } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { ffmpegAvailable } = require('../services/ffmpegCheck');
const config = require('../config');

const router = express.Router();

// Active FFmpeg processes keyed by recording ID
const activeRecordings = new Map();

// GET /api/recordings
router.get('/', authenticate, (req, res) => {
  const recordings = getDb().prepare(`
    SELECT r.id, r.camera_id, r.camera_name, r.filename, r.started_at,
           r.stopped_at, r.file_size, r.duration_sec, r.status
    FROM recordings r
    WHERE r.user_id = ?
    ORDER BY r.started_at DESC
    LIMIT 100
  `).all(req.user.id);
  res.json({ recordings });
});

// POST /api/recordings/start
router.post('/start', authenticate, (req, res) => {
  const { cameraId } = req.body;
  if (!cameraId) return res.status(400).json({ error: 'cameraId required' });

  const db = getDb();
  const camera = db.prepare('SELECT id, name, link, link_type FROM cameras WHERE id = ?').get(cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const linkType = (camera.link_type || '').toUpperCase();
  const recordable = ['M3U8', 'HLS', 'RTSP', 'HTTP', 'HTTPS'];
  if (!recordable.includes(linkType)) {
    return res.status(400).json({ error: `Recording not supported for ${linkType || 'unknown'} streams` });
  }
  if (linkType === 'RTSP' && !ffmpegAvailable()) {
    return res.status(503).json({ error: 'FFmpeg tidak terpasang — tidak bisa merekam RTSP' });
  }

  // Check concurrent recording limit per user (max 2)
  const activeCount = [...activeRecordings.values()].filter(r => r.userId === req.user.id).length;
  if (activeCount >= 2) return res.status(429).json({ error: 'Maximum 2 concurrent recordings per user' });

  const recId = uuidv4();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${camera.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.mp4`;
  const filePath = path.join(config.recordingsDir, filename);

  fs.mkdirSync(config.recordingsDir, { recursive: true });

  db.prepare(`
    INSERT INTO recordings (id, camera_id, user_id, camera_name, filename, file_path, started_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
  `).run(recId, camera.id, req.user.id, camera.name, filename, filePath);

  // Start FFmpeg: input stream, copy to MP4
  const args = ['-y'];
  if (linkType === 'RTSP') {
    args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  } else {
    args.push('-user_agent', 'P4US-CCTV/1.0');
  }
  args.push(
    '-i', camera.link,
    '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov',
    filePath,
  );

  const ffmpeg = spawn(config.ffmpegPath, args, { stdio: 'ignore' });

  ffmpeg.on('error', (err) => {
    console.error(`FFmpeg error for recording ${recId}:`, err.message);
    db.prepare("UPDATE recordings SET status = 'failed', stopped_at = unixepoch() WHERE id = ?").run(recId);
    activeRecordings.delete(recId);
  });

  ffmpeg.on('close', (code) => {
    if (activeRecordings.has(recId)) {
      // Closed unexpectedly
      const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      db.prepare(`
        UPDATE recordings
        SET status = ?, stopped_at = unixepoch(), file_size = ?,
            duration_sec = (unixepoch() - started_at)
        WHERE id = ?
      `).run(code === 0 ? 'completed' : 'failed', stats?.size ?? 0, recId);
      activeRecordings.delete(recId);
    }
  });

  activeRecordings.set(recId, { ffmpeg, userId: req.user.id, cameraId: camera.id });

  res.status(201).json({ recordingId: recId, filename, message: 'Recording started' });
});

// POST /api/recordings/stop/:id
router.post('/stop/:id', authenticate, (req, res) => {
  const recId = req.params.id;
  const entry = activeRecordings.get(recId);

  if (!entry) return res.status(404).json({ error: 'Active recording not found' });
  if (entry.userId !== req.user.id) return res.status(403).json({ error: 'Not your recording' });

  const db = getDb();
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recId);

  entry.ffmpeg.kill('SIGTERM');
  activeRecordings.delete(recId);

  setTimeout(() => {
    const stats = fs.existsSync(rec.file_path) ? fs.statSync(rec.file_path) : null;
    db.prepare(`
      UPDATE recordings
      SET status = 'completed', stopped_at = unixepoch(),
          file_size = ?, duration_sec = (unixepoch() - started_at)
      WHERE id = ?
    `).run(stats?.size ?? 0, recId);
  }, 1500);

  res.json({ message: 'Recording stopping', recordingId: recId });
});

// GET /api/recordings/download/:id
// Returns file stream — Bearer token checked via header (frontend uses fetch + blob)
router.get('/download/:id', authenticate, (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  if (rec.status !== 'completed') return res.status(409).json({ error: 'Recording not yet complete' });

  const safePath = path.resolve(rec.file_path);
  const recordingsDir = path.resolve(config.recordingsDir);
  if (!safePath.startsWith(recordingsDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'File not found on server' });

  res.setHeader('Content-Disposition', `attachment; filename="${rec.filename.replace(/"/g, '')}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(safePath);
});

// DELETE /api/recordings/:id
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });

  if (activeRecordings.has(rec.id)) return res.status(409).json({ error: 'Recording still active' });

  try { fs.unlinkSync(rec.file_path); } catch {}
  db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);

  res.json({ message: 'Recording deleted' });
});

module.exports = router;
