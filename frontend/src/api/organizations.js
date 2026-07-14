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

// Token-based invitations (slice 3) — for people who don't have an account
// yet, coexists with addOrgMember above (direct-add of an existing user).
export const createOrgInvitation = (orgId, email, role) =>
  apiFetch(`/organizations/${orgId}/invitations`, { method: 'POST', body: { email, role } });
export const listOrgInvitations = (orgId) => apiFetch(`/organizations/${orgId}/invitations`);
