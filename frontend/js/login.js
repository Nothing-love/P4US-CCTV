'use strict';

// Redirect if already authenticated
const existingToken = localStorage.getItem('p4us_token');
if (existingToken) {
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${existingToken}` } })
    .then(r => { if (r.ok) location.replace('/dashboard'); })
    .catch(() => {});
}

// Handle URL params
const params = new URLSearchParams(location.search);
if (params.get('verified') === '1') showAlert('alert-login', 'success', 'Email terverifikasi! Akun menunggu persetujuan admin.');
if (params.get('session') === 'expired') showAlert('alert-login', 'error', 'Sesi habis. Silakan masuk kembali.');

// Logo fallback
document.getElementById('logo-img').addEventListener('error', function() { this.style.display = 'none'; });

// Tab switching
document.getElementById('tab-btn-login').addEventListener('click', function() { switchTab('login', this); });
document.getElementById('tab-btn-register').addEventListener('click', function() { switchTab('register', this); });

// Form submissions
document.getElementById('form-login').addEventListener('submit', doLogin);
document.getElementById('form-reg').addEventListener('submit', doRegister);

function switchTab(name, btn) {
  document.querySelectorAll('.tab-login').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`panel-${name}`).classList.add('active');
}

function showAlert(id, type, msg) {
  const el = document.getElementById(id);
  el.className = `alert ${type}`;
  el.textContent = msg;
}

function clearAlert(id) {
  const el = document.getElementById(id);
  el.className = 'alert';
  el.textContent = '';
}

async function doLogin(e) {
  e.preventDefault();
  clearAlert('alert-login');
  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Memproses…';

  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-pass').value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Login gagal');

    localStorage.setItem('p4us_token', data.token);
    localStorage.setItem('p4us_refresh', data.refreshToken);
    localStorage.setItem('p4us_user', JSON.stringify(data.user));
    location.replace('/dashboard');
  } catch (err) {
    showAlert('alert-login', 'error', err.message);
    btn.disabled = false;
    btn.textContent = 'MASUK';
  }
}

async function doRegister(e) {
  e.preventDefault();
  clearAlert('alert-reg');
  const btn = document.getElementById('btn-reg');
  btn.disabled = true;
  btn.textContent = 'Mendaftar…';

  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('reg-name').value.trim(),
        email: document.getElementById('reg-email').value.trim(),
        password: document.getElementById('reg-pass').value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Pendaftaran gagal');

    showAlert('alert-reg', 'success', data.message);
    document.getElementById('form-reg').reset();
  } catch (err) {
    showAlert('alert-reg', 'error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'DAFTAR';
  }
}
