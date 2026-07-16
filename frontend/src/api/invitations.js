import { apiFetch, setAccessToken } from './client.js';

export const previewInvitation = (token) => apiFetch(`/invitations/${token}`);

// Same response shape as signup/login ({accessToken, user}) — the new
// account is logged in immediately, same as api/auth.js's signup/login.
// The invitee supplies their own email here (FEATURE_REQUEST.md's "Remove
// email-based invitations" entry) — the invitation itself no longer carries
// one.
export async function acceptInvitation(token, { username, email, password }) {
  const data = await apiFetch(`/invitations/${token}/accept`, { method: 'POST', body: { username, email, password } });
  setAccessToken(data.accessToken);
  return data.user;
}

export const revokeInvitation = (id) => apiFetch(`/invitations/${id}/revoke`, { method: 'POST' });
