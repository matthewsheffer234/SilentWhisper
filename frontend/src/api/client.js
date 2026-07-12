// In-memory access token only — never localStorage/sessionStorage
// (PROJECT_PLAN.md Section 3: either turns a single XSS bug into full
// account takeover). Lost on page reload by design; restored via a silent
// POST /auth/refresh call on app start, which relies on the httpOnly
// refresh cookie instead.
let accessToken = null;
let onAuthLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

// Called by AuthContext; invoked when a refresh attempt fails, so the app
// can drop back to the login screen from anywhere a request happens to fail.
export function setOnAuthLost(handler) {
  onAuthLost = handler;
}

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8000/api').replace(/\/$/, '');

let refreshInFlight = null;

async function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = await res.json();
        setAccessToken(body.accessToken);
        return body.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Every non-auth request goes through here. A 401 triggers exactly one
// silent refresh-and-retry; a second 401 means the session is genuinely
// gone, so it surfaces to the app instead of looping forever.
export async function apiFetch(path, { method = 'GET', body, headers = {}, _isRetry = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_isRetry) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      return apiFetch(path, { method, body, headers, _isRetry: true });
    }
    setAccessToken(null);
    onAuthLost();
  }

  if (res.status === 204) {
    return null;
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const error = new Error(data?.error || `Request failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return data;
}

export { refreshAccessToken, API_BASE };
