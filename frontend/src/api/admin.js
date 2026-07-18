import { apiFetch } from './client.js';

// System-admin-only account lifecycle (FEATURE_REQUEST.md entry 1, slice 4)
// — backs SystemAdminPanel.jsx. Every call redundantly re-checks
// authorization server-side (a direct isSystemAdminUser gate); this panel
// only ever being rendered for a system admin is a UI convenience, never
// the actual enforcement boundary, same as every other admin panel in this
// app.
export const createAdminUser = ({ username, email, password, displayName, organizationId }) =>
  apiFetch('/admin/users', {
    method: 'POST',
    body: {
      username,
      email,
      password,
      ...(displayName ? { displayName } : {}),
      ...(organizationId ? { organizationId } : {}),
    },
  });
export const listAdminUsers = ({ limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiFetch(`/admin/users${qs ? `?${qs}` : ''}`);
};
export const disableUser = (userId) => apiFetch(`/admin/users/${userId}/disable`, { method: 'POST' });
export const enableUser = (userId) => apiFetch(`/admin/users/${userId}/enable`, { method: 'POST' });

// System Admin panel: manage organizations and existing users.
export const promoteUser = (userId) => apiFetch(`/admin/users/${userId}/promote`, { method: 'POST' });
export const demoteUser = (userId) => apiFetch(`/admin/users/${userId}/demote`, { method: 'POST' });
export const globalResetPassword = (userId, newPassword) =>
  apiFetch(`/admin/users/${userId}/reset-password`, { method: 'POST', body: { newPassword } });
export const listUserOrganizations = (userId) => apiFetch(`/admin/users/${userId}/organizations`);
