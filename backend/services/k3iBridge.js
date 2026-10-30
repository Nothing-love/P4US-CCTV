/**
 * K3I Korlantas bridge.
 * Authenticates to the K3I operator API with configured credentials, caches the
 * session token, and exposes it (plus proper Referer/Origin) so that streams
 * served by K3I hosts can be fetched reliably through the stream proxy.
 *
 * Auth flow (from the K3I web client):
 *   POST {base}/v1/auth/login   body: { username, password }
 *     -> { data: { accessToken, ... } }
 *   Authenticated requests send header:  Authorization: <accessToken>
 *   Live camera list:  GET {base}/v3/cctv?operation_id=<id>
 */
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const PORTAL_ORIGIN = 'https://k3i.korlantas.polri.go.id';
const TOKEN_TTL_MS = 50 * 60_000; // refresh ~10 min before a typical 1h expiry
const CACHE_FILE = path.join(os.tmpdir(), 'p4us-k3i-session.json');
// Jeda minimum antar-percobaan login (berapa pun hasilnya) supaya tidak pernah
// "mengetuk" portal beruntun, mis. saat stream K3I terus membalas 401.
const MIN_LOGIN_INTERVAL_MS = 20_000;

// Token + login-backoff state, persisted across restarts so a restart never
// re-hammers (and keeps locked) an account the portal has temporarily rejected.
const persisted = loadState();
// session.cookie: sebagian deploy K3I memakai AUTH BERBASIS COOKIE (token tidak
// ada di localStorage, hanya cookie sesi). Kalau cookie di-set, kita kirim
// sebagai header Cookie alih-alih Authorization.
let session = { token: persisted.token, expiresAt: persisted.expiresAt, cookie: persisted.cookie };
let cooldownUntil = persisted.cooldownUntil;
let consecutiveFailures = persisted.consecutiveFailures;
let inflightLogin = null;
let lastLoginAt = 0;   // timestamp percobaan login terakhir (throttle in-memory)

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const valid = Date.now() < (s.expiresAt || 0);
    return {
      token: (s.token && valid) ? s.token : null,
      cookie: (s.cookie && valid) ? s.cookie : null,
      expiresAt: s.expiresAt || 0,
      cooldownUntil: s.cooldownUntil || 0,
      consecutiveFailures: s.consecutiveFailures || 0,
    };
  } catch {}
  return { token: null, cookie: null, expiresAt: 0, cooldownUntil: 0, consecutiveFailures: 0 };
}

function saveState() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      token: session.token, cookie: session.cookie, expiresAt: session.expiresAt,
      cooldownUntil, consecutiveFailures,
    }), { mode: 0o600 });
  } catch {}
}

function isConfigured() {
  return !!(config.k3i.username && config.k3i.password);
}

// Hosts whose streams are served behind the K3I operator session.
function isK3iHost(host) {
  return /k3i-korlantas\.id|korlantas\.polri\.go\.id/i.test(host || '');
}

// Backoff after rejected logins so we don't keep an account locked by hammering.
function cooldownRemainingMs() {
  return Math.max(0, cooldownUntil - Date.now());
}

/** Clear the backoff so the next call logs in immediately (manual retry). */
function resetCooldown() {
  cooldownUntil = 0;
  consecutiveFailures = 0;
  saveState();
}

// Catat kegagalan login → backoff makin lama: 30 menit × kegagalan, maks 3 jam.
// Dipakai untuk HTTP ditolak MAUPUN error jaringan/timeout, agar portal tidak
// terus diketuk saat sedang bermasalah (penyebab utama akun terkunci).
function registerFailure() {
  consecutiveFailures++;
  cooldownUntil = Date.now() + Math.min(consecutiveFailures * 30, 180) * 60_000;
  saveState();
}

async function login() {
  if (!isConfigured()) throw new Error('Kredensial K3I belum dikonfigurasi (.env)');

  if (cooldownRemainingMs() > 0) {
    const mins = Math.ceil(cooldownRemainingMs() / 60000);
    throw new Error(`Login K3I sedang cooldown (~${mins} menit lagi) setelah ditolak berulang`);
  }
  // Throttle: jangan login lagi kalau barusan dicoba (hindari badai login).
  if (Date.now() - lastLoginAt < MIN_LOGIN_INTERVAL_MS) {
    throw new Error('Login K3I baru saja dicoba — menunggu sebentar');
  }
  lastLoginAt = Date.now();

  const url = `${config.k3i.baseUrl}/v1/auth/login`;
  let res;
  try {
    res = await axios.post(
      url,
      { username: config.k3i.username, password: config.k3i.password },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/login` },
        validateStatus: (s) => s < 500,
      }
    );
  } catch (err) {
    // Error jaringan / timeout juga dihitung gagal → kena backoff.
    registerFailure();
    throw new Error(`Login K3I gagal (jaringan): ${err.code || err.message}`);
  }

  if (res.status !== 200) {
    registerFailure();
    throw new Error(`Login K3I ditolak (HTTP ${res.status})`);
  }

  const token = res.data?.data?.accessToken || res.data?.accessToken;
  if (!token) {
    registerFailure();
    throw new Error('Login K3I gagal: accessToken tidak ditemukan di respons');
  }

  consecutiveFailures = 0;
  cooldownUntil = 0;
  session = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  saveState();
  return token;
}

/** Returns a valid token, logging in (or reusing an in-flight login) as needed. */
async function getToken() {
  if (session.token && Date.now() < session.expiresAt) return session.token;
  if (inflightLogin) return inflightLogin;
  inflightLogin = login().finally(() => { inflightLogin = null; });
  return inflightLogin;
}

/** Force a fresh login on next use (e.g. after a 401 from a stream). */
function invalidate() {
  session = { token: null, expiresAt: 0, cookie: null };
  saveState();
}

/**
 * Use a token copied from a logged-in K3I browser session (localStorage
 * "tbp-token"), bypassing the username/password login entirely. Handy when the
 * login endpoint is rate-limited: one valid token syncs all coordinates.
 */
function setToken(value, ttlMs = 55 * 60_000) {
  const v = String(value || '').trim();
  // Deteksi: string cookie ("name=value; ...") vs token bearer (JWT/opaque).
  // Cookie selalu memuat '=' (dan biasanya ';'); token tidak.
  const isCookie = /[=;]/.test(v);
  session = isCookie
    ? { token: null, cookie: v, expiresAt: Date.now() + 6 * 60 * 60_000 } // cookie ~6 jam
    : { token: v, cookie: null, expiresAt: Date.now() + ttlMs };           // token ~55 mnt
  consecutiveFailures = 0;
  cooldownUntil = 0;
  saveState();
}

/**
 * Auth headers for fetching a K3I stream. Best-effort: if login fails the
 * caller should still try the request unauthenticated (many K3I HLS streams
 * are open), so this never throws.
 *
 * allowLogin=false → HANYA pakai token yang sudah ada; TIDAK pernah memulai
 * login baru. Dipakai pemeriksaan kesehatan latar agar proses otomatis tak
 * pernah mengetuk portal K3I (mencegah akun terkunci). Login hanya terjadi saat
 * user benar-benar membuka stream K3I atau admin melakukan sync manual.
 */
async function getStreamHeaders({ allowLogin = true } = {}) {
  const headers = { Referer: `${PORTAL_ORIGIN}/`, Origin: PORTAL_ORIGIN };
  const valid = Date.now() < session.expiresAt;
  if (session.cookie && valid) { headers.Cookie = session.cookie; return headers; }
  const hasToken = session.token && valid;
  if (hasToken) { headers.Authorization = session.token; return headers; }
  if (!allowLogin || !isConfigured()) return headers;
  try {
    headers.Authorization = await getToken();
  } catch {
    // Stay unauthenticated; open streams still work.
  }
  return headers;
}

/** Raw single-page fetch from the K3I cctv API (returns the full envelope). */
async function fetchCctvPage(params = {}) {
  // Auth via cookie (bila di-set) ATAU token bearer (login username/password).
  const headers = { Referer: `${PORTAL_ORIGIN}/`, Origin: PORTAL_ORIGIN };
  if (session.cookie && Date.now() < session.expiresAt) headers.Cookie = session.cookie;
  else headers.Authorization = await getToken();
  const res = await axios.get(`${config.k3i.baseUrl}/v3/cctv`, {
    params: { operation_id: config.k3i.operationId, ...params },
    headers,
    timeout: 25000,
    validateStatus: (s) => s < 500,
  });
  if (res.status === 401) { invalidate(); throw new Error('Sesi K3I kedaluwarsa (token/cookie ditolak)'); }
  if (res.status !== 200) throw new Error(`K3I cctv API HTTP ${res.status}`);
  return res.data;
}

/**
 * Fetch the full camera list. The API returns every camera in `data` when a
 * large `limit` is passed (envelope: { data: [...], query: {...} }).
 */
async function getCameras() {
  const env = await fetchCctvPage({ page: 1, limit: 10000 });
  return Array.isArray(env?.data) ? env.data : (Array.isArray(env) ? env : []);
}

module.exports = {
  isConfigured, isK3iHost, invalidate, resetCooldown, setToken,
  getStreamHeaders, getCameras,
};
