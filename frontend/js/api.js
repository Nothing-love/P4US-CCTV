/* P4US CCTV — API Client */
const API_BASE = '';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('p4us_token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.code === 'TOKEN_EXPIRED') {
      const refreshed = await refreshToken();
      if (refreshed) return apiFetch(path, options);
    }
    logout();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

async function refreshToken() {
  const refresh = localStorage.getItem('p4us_refresh');
  if (!refresh) return false;

  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    localStorage.setItem('p4us_token', data.token);
    localStorage.setItem('p4us_refresh', data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function logout() {
  const refresh = localStorage.getItem('p4us_refresh');
  const token = localStorage.getItem('p4us_token');
  if (token && refresh) {
    fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ refreshToken: refresh }),
    }).catch(() => {});
  }
  localStorage.removeItem('p4us_token');
  localStorage.removeItem('p4us_refresh');
  localStorage.removeItem('p4us_user');
  location.replace('/?session=expired');
}

const api = {
  get:    (path)        => apiFetch(path),
  post:   (path, body)  => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  put:    (path, body)  => apiFetch(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch:  (path, body)  => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path)        => apiFetch(path, { method: 'DELETE' }),
};

function currentUser() {
  try { return JSON.parse(localStorage.getItem('p4us_user')); } catch { return null; }
}

// Guard: redirect to login if not authenticated
function requireAuth() {
  if (!localStorage.getItem('p4us_token')) {
    location.replace('/');
    return false;
  }
  return true;
}
