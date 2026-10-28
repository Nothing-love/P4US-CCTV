const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db/database');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = getDb()
      .prepare('SELECT id, email, name, role, status FROM users WHERE id = ?')
      .get(payload.sub);

    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Account not active' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth untuk endpoint media yang dimuat lewat <img>/<video> (tak bisa kirim
// header Authorization) → terima token dari header ATAU query ?_auth=.
// Dipakai hanya untuk proxy media same-origin (mis. /api/stream/still).
function authenticateMedia(req, res, next) {
  const h = req.headers.authorization;
  const token = (h && h.startsWith('Bearer ')) ? h.slice(7) : (req.query._auth || '');
  if (!token) return res.status(401).json({ error: 'Authorization required' });
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = getDb()
      .prepare('SELECT id, email, name, role, status FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account not active' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateMedia, requireRole };
