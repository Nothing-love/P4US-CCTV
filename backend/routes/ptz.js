/**
 * PTZ Control Routes
 * Supports Dahua HTTP CGI and Hikvision ISAPI protocols.
 * PTZ capability is detected per camera host type.
 */
const express = require('express');
const axios = require('axios');
const { authenticate } = require('../middleware/authMiddleware');
const { getDb } = require('../db/database');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Rate limit PTZ commands (max 30/min to prevent accidental continuous movement)
router.use(createRateLimiter(60_000, 30, 'PTZ command rate limit exceeded'));

const PTZ_COMMANDS = {
  up:         { dahua: 'Up',          hik: '{ "pan": 0, "tilt": 1, "zoom": 0 }' },
  down:       { dahua: 'Down',        hik: '{ "pan": 0, "tilt": -1, "zoom": 0 }' },
  left:       { dahua: 'Left',        hik: '{ "pan": -1, "tilt": 0, "zoom": 0 }' },
  right:      { dahua: 'Right',       hik: '{ "pan": 1, "tilt": 0, "zoom": 0 }' },
  zoom_in:    { dahua: 'ZoomTele',    hik: '{ "pan": 0, "tilt": 0, "zoom": 1 }' },
  zoom_out:   { dahua: 'ZoomWide',    hik: '{ "pan": 0, "tilt": 0, "zoom": -1 }' },
  stop:       { dahua: 'Stop',        hik: '{ "pan": 0, "tilt": 0, "zoom": 0 }' },
};

async function sendDahuaPTZ(baseUrl, channel, command, cred) {
  const auth = cred ? { username: cred.split(':')[0], password: cred.split(':')[1] } : undefined;
  const url = `${baseUrl}/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=${command}&arg1=0&arg2=5&arg3=0`;
  const res = await axios.get(url, { auth, timeout: 3000 });
  return res.status === 200;
}

async function sendHikvisionPTZ(baseUrl, channel, body, cred) {
  const auth = cred ? { username: cred.split(':')[0], password: cred.split(':')[1] } : undefined;
  const url = `${baseUrl}/ISAPI/PTZCtrl/channels/${channel}/continuous`;
  const res = await axios.put(url, body, {
    auth, timeout: 3000,
    headers: { 'Content-Type': 'application/json' },
  });
  return res.status < 300;
}

// GET /api/ptz/:cameraId/capabilities
router.get('/:cameraId/capabilities', authenticate, (req, res) => {
  const camera = getDb().prepare(`
    SELECT id, ptz_capable, ptz_type, host, link, access_class, credentials
    FROM cameras WHERE id = ?
  `).get(req.params.cameraId);

  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  res.json({
    cameraId: camera.id,
    ptzCapable: Boolean(camera.ptz_capable),
    ptzType: camera.ptz_type || null,
    commands: camera.ptz_capable ? Object.keys(PTZ_COMMANDS) : [],
  });
});

// POST /api/ptz/:cameraId/command
router.post('/:cameraId/command', authenticate, async (req, res) => {
  const { command, channel = 1 } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!PTZ_COMMANDS[command]) {
    return res.status(400).json({ error: `Unknown command. Valid: ${Object.keys(PTZ_COMMANDS).join(', ')}` });
  }

  const camera = getDb().prepare(`
    SELECT id, ptz_capable, ptz_type, host, scheme, link, credentials
    FROM cameras WHERE id = ?
  `).get(req.params.cameraId);

  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  if (!camera.ptz_capable) return res.status(400).json({ error: 'Camera does not support PTZ' });

  const baseUrl = `${camera.scheme || 'http'}://${camera.host}`;
  const cred = camera.credentials || null;
  const cmd = PTZ_COMMANDS[command];

  try {
    let success = false;

    if (camera.ptz_type === 'dahua') {
      success = await sendDahuaPTZ(baseUrl, channel, cmd.dahua, cred);
    } else if (camera.ptz_type === 'hikvision') {
      success = await sendHikvisionPTZ(baseUrl, channel, cmd.hik, cred);
    } else {
      return res.status(400).json({ error: 'Unknown PTZ type' });
    }

    res.json({ success, command, cameraId: camera.id });
  } catch (err) {
    if (err.response?.status === 401) return res.status(401).json({ error: 'PTZ auth failed' });
    if (err.code === 'ECONNABORTED') return res.status(504).json({ error: 'PTZ command timed out' });
    res.status(502).json({ error: 'PTZ command failed' });
  }
});

module.exports = router;
