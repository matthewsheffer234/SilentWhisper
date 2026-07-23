import { apiFetch, fetchAllPages } from './client.js';

// organizationId stays optional everywhere below (FEATURE_REQUEST.md entry 1,
// slice 3): the backend defaults to the caller's sole org membership when
// omitted, a no-op for every account with exactly one org — the org switcher
// only needs to pass it once a second org actually exists.
//
// Finding 3, docs/reviews/security-performance-review-2026-07-20.md: GET
// /workspaces is now offset-paginated server-side; this loops every page
// into the flat list the sidebar/org-switcher render, the same
// fetchAllPages() tradeoff already used for listOrganizations/listChannels/
// listDirectMessages. Finding 4: takes an optional `onPage` callback
// (forwarded to fetchAllPages) so ChatShell.jsx can render/select against
// the first page immediately instead of waiting on every page.
export const listWorkspaces = (onPage) => fetchAllPages('/workspaces', 'workspaces', { onPage });
export const createWorkspace = (name, visibility, organizationId) =>
  apiFetch('/workspaces', {
    method: 'POST',
    body: { name, ...(visibility ? { visibility } : {}), ...(organizationId ? { organizationId } : {}) },
  });
export const inviteWorkspaceMember = (workspaceId, username, role) =>
  apiFetch(`/workspaces/${workspaceId}/members`, { method: 'POST', body: { username, role } });

// Invitations (slice 3): token-based, for people who don't have an account
// yet — coexists with inviteWorkspaceMember above (direct-add of an existing
// user), doesn't replace it. No email is collected here (FEATURE_REQUEST.md's
// "Remove email-based invitations" entry) — the invitee supplies their own
// at redemption time.
export const createWorkspaceInvitation = (workspaceId, role) =>
  apiFetch(`/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { role } });
// Finding 3: now offset-paginated server-side; looped into a flat list for
// UserManagementPanel.jsx's existing invitation-revoke UI rather than adding
// a second Pager next to the one it already has for members.
export const listWorkspaceInvitations = (workspaceId) =>
  fetchAllPages(`/workspaces/${workspaceId}/invitations`, 'invitations');

// Membership invitations (FEATURE_REQUEST.md "Live notification system..."):
// for an *existing* account — proposes membership, notified live, the
// recipient accepts/declines via api/notifications.js's
// accept/declineMembershipInvitation. Distinct from both
// inviteWorkspaceMember (instant) and createWorkspaceInvitation (token-based,
// for people with no account yet).
export const createWorkspaceMembershipInvitation = (workspaceId, userId, role) =>
  apiFetch(`/workspaces/${workspaceId}/membership-invitations`, { method: 'POST', body: { userId, role } });

// Self-service workspace subscription (FEATURE_REQUEST.md). organizationId
// is required here in practice once an account belongs to 2+ orgs — the
// backend 400s without it (resolveCallerOrganization) — so callers must pass
// the currently-selected org once the org switcher exists.
//
// Finding 3: now offset-paginated server-side; BrowseWorkspacesPanel.jsx
// keeps its existing flat-list "browse and join" rendering via
// fetchAllPages() rather than growing pager UI for what's meant to be a
// simple browse sheet.
export const listDiscoverableWorkspaces = (organizationId) =>
  fetchAllPages(`/workspaces/discoverable${organizationId ? `?organizationId=${organizationId}` : ''}`, 'workspaces');
export const subscribeToWorkspace = (workspaceId) =>
  apiFetch(`/workspaces/${workspaceId}/subscribe`, { method: 'POST' });

// FEATURE_REQUEST.md entry 2: now offset-paginated ({members, total, limit,
// offset}) — UserManagementPanel.jsx renders a Pager against the raw
// response instead of a flat array.
export const listWorkspaceMembers = (workspaceId, { limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/members${qs ? `?${qs}` : ''}`);
};
export const changeWorkspaceMemberRole = (workspaceId, userId, role) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: { role } });
export const removeWorkspaceMember = (workspaceId, userId) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
export const resetWorkspaceMemberPassword = (workspaceId, userId, newPassword) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}/reset-password`, { method: 'POST', body: { newPassword } });

export const archiveWorkspace = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/archive`, { method: 'POST' });
export const unarchiveWorkspace = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/unarchive`, { method: 'POST' });

// New (FEATURE_REQUEST.md entry 1, slice 4).
export const listAllWorkspacesAdmin = ({ limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiFetch(`/workspaces/admin/all${qs ? `?${qs}` : ''}`);
};
export const transferWorkspaceOwnership = (workspaceId, username) =>
  apiFetch(`/workspaces/${workspaceId}/transfer-ownership`, { method: 'POST', body: { username } });
export const changeWorkspaceVisibility = (workspaceId, visibility) =>
  apiFetch(`/workspaces/${workspaceId}/visibility`, { method: 'POST', body: { visibility } });
export const updateWorkspaceSettings = (workspaceId, { managersCanArchive }) =>
  apiFetch(`/workspaces/${workspaceId}/settings`, { method: 'POST', body: { managersCanArchive } });
// FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"), Part 2.
export const renameWorkspace = (workspaceId, name) => apiFetch(`/workspaces/${workspaceId}`, { method: 'PATCH', body: { name } });

// FEATURE_REQUEST.md entry 2: GET /workspaces/:workspaceId/channels is now
// offset-paginated server-side; this loops every page into the flat list
// the channel sidebar renders, rather than pushing pager UI onto ordinary
// channel navigation. Finding 4: optional `onPage` callback, see
// listWorkspaces above.
export const listChannels = (workspaceId, onPage) =>
  fetchAllPages(`/workspaces/${workspaceId}/channels`, 'channels', { onPage });
export const createChannel = (workspaceId, name, type) =>
  apiFetch(`/workspaces/${workspaceId}/channels`, { method: 'POST', body: { name, type } });
export const joinChannel = (workspaceId, channelId) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/join`, { method: 'POST' });
export const addChannelMember = (workspaceId, channelId, username) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/members`, { method: 'POST', body: { username } });
// FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"), Part 4 — the
// delete counterpart addChannelMember never had: removes someone from just
// this channel, not the whole workspace (removeWorkspaceMember, above).
export const removeChannelMember = (workspaceId, channelId, userId) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/members/${userId}`, { method: 'DELETE' });
// Part 2.
export const renameChannel = (workspaceId, channelId, name) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}`, { method: 'PATCH', body: { name } });

// FEATURE_REQUEST.md's "channel details panel" entry — the full roster, not
// the mention-autocomplete search endpoint above. FEATURE_REQUEST.md entry
// 2: now offset-paginated ({members, total, limit, offset}) —
// ChannelDetailsPanel.jsx renders a Pager against the raw response instead
// of a flat array.
export const listChannelMembers = (workspaceId, channelId, { limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit);
  if (offset !== undefined) params.set('offset', offset);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/members${qs ? `?${qs}` : ''}`);
};

export const listMessages = (channelId, { limit, before, parentMessageId } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (before) params.set('before', before);
  if (parentMessageId) params.set('parentMessageId', parentMessageId);
  const qs = params.toString();
  return apiFetch(`/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
};

// FEATURE_REQUEST.md's @mention autocomplete entry.
export const searchChannelMembers = (channelId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/channels/${channelId}/members${qs ? `?${qs}` : ''}`);
};

// FEATURE_REQUEST.md's "unified people picker" entry. searchWorkspacePeople
// searches every account (for adding to the workspace); searchWorkspaceMembers
// searches only the current roster (for private-channel invite —
// pass channelId — and ownership transfer).
export const searchWorkspacePeople = (workspaceId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/people-search${qs ? `?${qs}` : ''}`);
};
export const searchWorkspaceMembers = (workspaceId, query, { channelId } = {}) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (channelId) params.set('channelId', channelId);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/members-search${qs ? `?${qs}` : ''}`);
};
