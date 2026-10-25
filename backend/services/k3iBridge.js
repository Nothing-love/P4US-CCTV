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

// Token + login-backoff state, persisted across restarts so a restart never
// re-hammers (and keeps locked) an account the portal has temporarily rejected.
const persisted = loadState();
let session = { token: persisted.token, expiresAt: persisted.expiresAt };
let cooldownUntil = persisted.cooldownUntil;
let consecutiveFailures = persisted.consecutiveFailures;
let inflightLogin = null;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return {
      token: (s.token && Date.now() < s.expiresAt) ? s.token : null,
      expiresAt: s.expiresAt || 0,
      cooldownUntil: s.cooldownUntil || 0,
      consecutiveFailures: s.consecutiveFailures || 0,
    };
  } catch {}
  return { token: null, expiresAt: 0, cooldownUntil: 0, consecutiveFailures: 0 };
}

function saveState() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      token: session.token, expiresAt: session.expiresAt, cooldownUntil, consecutiveFailures,
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

async function login() {
  if (!isConfigured()) throw new Error('Kredensial K3I belum dikonfigurasi (.env)');

  if (cooldownRemainingMs() > 0) {
    const mins = Math.ceil(cooldownRemainingMs() / 60000);
    throw new Error(`Login K3I sedang cooldown (~${mins} menit lagi) setelah ditolak berulang`);
  }

  const url = `${config.k3i.baseUrl}/v1/auth/login`;
  const res = await axios.post(
    url,
    { username: config.k3i.username, password: config.k3i.password },
    {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/login` },
      validateStatus: (s) => s < 500,
    }
  );

  if (res.status !== 200) {
    // Exponential-ish backoff: 30 min × failures, capped at 3 hours.
    consecutiveFailures++;
    cooldownUntil = Date.now() + Math.min(consecutiveFailures * 30, 180) * 60_000;
    saveState();
    throw new Error(`Login K3I ditolak (HTTP ${res.status})`);
  }

  const token = res.data?.data?.accessToken || res.data?.accessToken;
  if (!token) throw new Error('Login K3I gagal: accessToken tidak ditemukan di respons');

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
  session = { token: null, expiresAt: 0 };
  saveState();
}

/**
 * Use a token copied from a logged-in K3I browser session (localStorage
 * "tbp-token"), bypassing the username/password login entirely. Handy when the
 * login endpoint is rate-limited: one valid token syncs all coordinates.
 */
function setToken(token, ttlMs = 55 * 60_000) {
  session = { token: String(token).trim(), expiresAt: Date.now() + ttlMs };
  consecutiveFailures = 0;
  cooldownUntil = 0;
  saveState();
}

/**
 * Auth headers for fetching a K3I stream. Best-effort: if login fails the
 * caller should still try the request unauthenticated (many K3I HLS streams
 * are open), so this never throws.
 */
async function getStreamHeaders() {
  const headers = { Referer: `${PORTAL_ORIGIN}/`, Origin: PORTAL_ORIGIN };
  const hasToken = session.token && Date.now() < session.expiresAt;
  if (!isConfigured() && !hasToken) return headers;
  try {
    headers.Authorization = await getToken();
  } catch {
    // Stay unauthenticated; open streams still work.
  }
  return headers;
}

/** Raw single-page fetch from the K3I cctv API (returns the full envelope). */
async function fetchCctvPage(params = {}) {
  const token = await getToken();
  const res = await axios.get(`${config.k3i.baseUrl}/v3/cctv`, {
    params: { operation_id: config.k3i.operationId, ...params },
    headers: { Authorization: token, Referer: `${PORTAL_ORIGIN}/`, Origin: PORTAL_ORIGIN },
    timeout: 25000,
    validateStatus: (s) => s < 500,
  });
  if (res.status === 401) { invalidate(); throw new Error('Sesi K3I kedaluwarsa'); }
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

function status() {
  return {
    configured: isConfigured(),
    loggedIn: !!session.token && Date.now() < session.expiresAt,
    cooldownMinutes: Math.ceil(cooldownRemainingMs() / 60000),
    baseUrl: config.k3i.baseUrl,
  };
}

module.exports = {
  isConfigured, isK3iHost, login, getToken, invalidate, resetCooldown, setToken,
  getStreamHeaders, getCameras, status,
};
