import { apiFetch, fetchAllPages } from './client.js';

// FEATURE_REQUEST.md entry 2: GET /organizations is now offset-paginated
// server-side; this loops every page into the flat list the org
// switcher/System Admin panel render, rather than pushing pager UI onto a
// list that's ordinarily just "every org the caller belongs to."
export const listOrganizations = () => fetchAllPages('/organizations', 'organizations');
export const createOrganization = (name) => apiFetch('/organizations', { method: 'POST', body: { name } });
// FEATURE_REQUEST.md entry 2: now offset-paginated ({members, total, limit,
// offset}) — OrgManagementPanel.jsx renders a Pager against the raw
// response instead of a flat array, unlike listOrganizations above.
export const listOrgMembers = (orgId, { limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiFetch(`/organizations/${orgId}/members${qs ? `?${qs}` : ''}`);
};
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
// No email is collected here (FEATURE_REQUEST.md's "Remove email-based
// invitations" entry) — the invitee supplies their own at redemption time.
export const createOrgInvitation = (orgId, role) =>
  apiFetch(`/organizations/${orgId}/invitations`, { method: 'POST', body: { role } });
export const listOrgInvitations = (orgId) => apiFetch(`/organizations/${orgId}/invitations`);

// Membership invitations (FEATURE_REQUEST.md "Live notification system..."):
// for an *existing* account — proposes membership, notified live, the
// recipient accepts/declines via api/notifications.js's
// accept/declineMembershipInvitation. Distinct from both addOrgMember
// (instant) and createOrgInvitation (token-based, for people with no
// account yet).
export const createOrgMembershipInvitation = (orgId, userId, role) =>
  apiFetch(`/organizations/${orgId}/membership-invitations`, { method: 'POST', body: { userId, role } });

// FEATURE_REQUEST.md's "unified people picker" entry.
export const searchOrgPeople = (orgId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/organizations/${orgId}/people-search${qs ? `?${qs}` : ''}`);
};

// FEATURE_REQUEST.md entry 3 (Direct Messages navigation): candidate pool
// for the "New Message" people picker — the org's own roster, gated on
// plain membership rather than searchOrgPeople's ORG_MANAGE_MEMBERS.
export const searchOrgMembers = (orgId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/organizations/${orgId}/members-search${qs ? `?${qs}` : ''}`);
};
