import { apiFetch, setAccessToken } from './client.js';

export const previewInvitation = (token) => apiFetch(`/invitations/${token}`);

// Same response shape as signup/login ({accessToken, user}) — the new
// account is logged in immediately, same as api/auth.js's signup/login.
export async function acceptInvitation(token, { username, password }) {
  const data = await apiFetch(`/invitations/${token}/accept`, { method: 'POST', body: { username, password } });
  setAccessToken(data.accessToken);
  return data.user;
}

export const revokeInvitation = (id) => apiFetch(`/invitations/${id}/revoke`, { method: 'POST' });
