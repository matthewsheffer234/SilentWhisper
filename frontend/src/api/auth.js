import { apiFetch, setAccessToken, API_BASE } from './client.js';

export async function login({ username, password }) {
  const data = await apiFetch('/auth/login', { method: 'POST', body: { username, password } });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function changePassword({ currentPassword, newPassword }) {
  const data = await apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function logout() {
  await apiFetch('/auth/logout', { method: 'POST' });
  setAccessToken(null);
}

export async function fetchCurrentUser() {
  const data = await apiFetch('/auth/me');
  return data.user;
}

// Session restore on page load: no access token exists yet in memory, so
// this calls the refresh endpoint directly (via fetch, not apiFetch, since
// apiFetch's own 401-retry logic would otherwise call this same endpoint).
export async function restoreSession() {
  const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!res.ok) return null;
  const body = await res.json();
  setAccessToken(body.accessToken);
  return fetchCurrentUser();
}
