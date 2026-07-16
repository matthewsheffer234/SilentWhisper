import { apiFetch } from './client.js';

export const listOrganizations = () => apiFetch('/organizations');
export const createOrganization = (name) => apiFetch('/organizations', { method: 'POST', body: { name } });
export const listOrgMembers = (orgId) => apiFetch(`/organizations/${orgId}/members`);
export const addOrgMember = (orgId, username, role) =>
  apiFetch(`/organizations/${orgId}/members`, { method: 'POST', body: { username, role } });
export const changeOrgMemberRole = (orgId, userId, role) =>
  apiFetch(`/organizations/${orgId}/members/${userId}`, { method: 'PATCH', body: { role } });
export const removeOrgMember = (orgId, userId) =>
  apiFetch(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' });

// System Admin panel: manage organizations and existing users.
export const renameOrganization = (orgId, name) =>
  apiFetch(`/organizations/${orgId}`, { method: 'PATCH', body: { name } });
export const archiveOrganization = (orgId) => apiFetch(`/organizations/${orgId}/archive`, { method: 'POST' });
export const unarchiveOrganization = (orgId) => apiFetch(`/organizations/${orgId}/unarchive`, { method: 'POST' });

// Token-based invitations (slice 3) — for people who don't have an account
// yet, coexists with addOrgMember above (direct-add of an existing user).
export const createOrgInvitation = (orgId, email, role) =>
  apiFetch(`/organizations/${orgId}/invitations`, { method: 'POST', body: { email, role } });
export const listOrgInvitations = (orgId) => apiFetch(`/organizations/${orgId}/invitations`);

// FEATURE_REQUEST.md's "unified people picker" entry.
export const searchOrgPeople = (orgId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/organizations/${orgId}/people-search${qs ? `?${qs}` : ''}`);
};
