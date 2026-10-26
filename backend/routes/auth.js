const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getDb } = require('../db/database');
const config = require('../config');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

function createTransporter() {
  if (!config.smtp.host || !config.smtp.user) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

function signAccessToken(userId) {
  return jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function signRefreshToken(userId) {
  const token = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  getDb().prepare('INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!user.email_verified) return res.status(403).json({ error: 'Email not verified' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Account pending admin approval' });
  if (user.status === 'disabled') return res.status(403).json({ error: 'Account disabled' });

  db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);

  res.json({
    token: signAccessToken(user.id),
    refreshToken: signRefreshToken(user.id),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  const db = getDb();
  const stored = db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(refreshToken);
  if (!stored || stored.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(stored.user_id);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account not active' });

  db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);

  res.json({
    token: signAccessToken(user.id),
    refreshToken: signRefreshToken(user.id),
  });
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    getDb().prepare('DELETE FROM refresh_tokens WHERE token = ? AND user_id = ?').run(refreshToken, req.user.id);
  }
  res.json({ message: 'Logged out' });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name required' });
  if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid input types' });
  }
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters' });
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Name must be 2–80 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (email.length > 254) return res.status(400).json({ error: 'Email too long' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const verificationToken = uuidv4();
  const hash = await bcrypt.hash(password, 12);
  const userId = uuidv4();

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status, email_verified, verification_token)
    VALUES (?, ?, ?, ?, 'viewer', 'pending', 0, ?)
  `).run(userId, email.trim().toLowerCase(), hash, name.trim(), verificationToken);

  // Send verification email if SMTP configured
  const transporter = createTransporter();
  if (transporter) {
    const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`;
    try {
      await transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: 'P4US CCTV – Verifikasi Email',
        html: `
          <h2>Selamat datang di P4US CCTV</h2>
          <p>Klik link berikut untuk memverifikasi email Anda:</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <p>Setelah verifikasi, akun Anda perlu disetujui oleh admin sebelum dapat digunakan.</p>
        `,
      });
    } catch (err) {
      console.error('Email send failed:', err.message);
    }
  }

  res.status(201).json({
    message: config.smtp.host
      ? 'Registration successful. Please check your email to verify your account.'
      : 'Registration successful. Admin will review and activate your account.',
    requiresEmailVerification: !!config.smtp.host,
  });
});

// GET /api/auth/verify-email
router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE verification_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });

  db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);

  res.redirect('/?verified=1');
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ─── Admin: User Management ───────────────────────────────────────────────

// GET /api/auth/users  (admin+)
router.get('/users', authenticate, requireRole('superadmin', 'admin'), (req, res) => {
  const users = getDb().prepare(`
    SELECT id, email, name, role, status, email_verified, last_login, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

// PATCH /api/auth/users/:id  (admin: approve/disable/change role)
router.patch('/users/:id', authenticate, requireRole('superadmin', 'admin'), (req, res) => {
  const { status, role } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Admins cannot change superadmin role
  if (user.role === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Cannot modify superadmin' });
  }

  const updates = [];
  const params = [];
  if (status && ['pending', 'active', 'disabled'].includes(status)) {
    updates.push('status = ?'); params.push(status);
    // Admin approval doubles as email verification (works without SMTP).
    if (status === 'active') updates.push('email_verified = 1');
  }
  if (role && ['admin', 'viewer'].includes(role) && req.user.role === 'superadmin') { updates.push('role = ?'); params.push(role); }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push('updated_at = unixepoch()');
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ message: 'User updated' });
});

// DELETE /api/auth/users/:id  (reject / remove a registration)
router.delete('/users/:id', authenticate, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'superadmin') return res.status(403).json({ error: 'Tidak bisa menghapus superadmin' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ message: 'User dihapus' });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const db = getDb();
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?').run(hash, req.user.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);

  res.json({ message: 'Password changed. Please log in again.' });
});

module.exports = router;
