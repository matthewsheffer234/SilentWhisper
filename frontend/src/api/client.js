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

// FEATURE_REQUEST.md entry 2: several list endpoints the sidebar/switcher
// UI treats as "my complete set of X" (own workspaces/orgs/channels/DMs)
// became offset-paginated server-side so no single request scans an
// unbounded table. Rather than push pager UI onto every navigational list
// (a real UX regression for "which channels am I in"), this loops bounded
// pages back into the flat array those call sites already expect —
// `itemsKey` names the response field the paginated route actually returns
// (e.g. "channels", "organizations" — matching GET /admin/users' and
// GET /workspaces/admin/all's precedent of naming the field after the
// resource, not a generic "items").
//
// Finding 4, docs/reviews/security-performance-review-2026-07-20.md: this
// used to await every page before the caller ever saw a result, so a user
// with hundreds of DMs/channels paid for N sequential round trips before
// the sidebar could render anything. The `onPage` callback fires after each
// page with the cumulative array so far, so a caller can render/select
// against the first page immediately while the rest keep streaming in
// behind the scenes — the returned promise still resolves to the complete
// list at the end, so an existing `.then(setX)`-only call site (nothing
// beyond the four core navigational lists needs the incremental callback)
// keeps working unmodified.
export async function fetchAllPages(path, itemsKey, { pageSize = 100, onPage } = {}) {
  let offset = 0;
  const all = [];
  for (;;) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    const sep = path.includes('?') ? '&' : '?';
    const page = await apiFetch(`${path}${sep}${params.toString()}`);
    const rows = page[itemsKey];
    all.push(...rows);
    offset += rows.length;
    onPage?.(all.slice());
    if (rows.length === 0 || offset >= page.total) break;
  }
  return all;
}

export { refreshAccessToken, API_BASE };
