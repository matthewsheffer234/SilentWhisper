import { apiFetch } from './client.js';

// System-admin-only account lifecycle (FEATURE_REQUEST.md entry 1, slice 4)
// — backs SystemAdminPanel.jsx. Every call redundantly re-checks
// authorization server-side (a direct isSystemAdminUser gate); this panel
// only ever being rendered for a system admin is a UI convenience, never
// the actual enforcement boundary, same as every other admin panel in this
// app.
export const createAdminUser = ({ username, email, password, organizationId }) =>
  apiFetch('/admin/users', { method: 'POST', body: { username, email, password, ...(organizationId ? { organizationId } : {}) } });
export const listAdminUsers = () => apiFetch('/admin/users');
export const disableUser = (userId) => apiFetch(`/admin/users/${userId}/disable`, { method: 'POST' });
export const enableUser = (userId) => apiFetch(`/admin/users/${userId}/enable`, { method: 'POST' });
