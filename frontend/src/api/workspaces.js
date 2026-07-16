import { apiFetch } from './client.js';

// organizationId stays optional everywhere below (FEATURE_REQUEST.md entry 1,
// slice 3): the backend defaults to the caller's sole org membership when
// omitted, a no-op for every account with exactly one org — the org switcher
// only needs to pass it once a second org actually exists.
export const listWorkspaces = () => apiFetch('/workspaces');
export const createWorkspace = (name, visibility, organizationId) =>
  apiFetch('/workspaces', {
    method: 'POST',
    body: { name, ...(visibility ? { visibility } : {}), ...(organizationId ? { organizationId } : {}) },
  });
export const inviteWorkspaceMember = (workspaceId, username, role) =>
  apiFetch(`/workspaces/${workspaceId}/members`, { method: 'POST', body: { username, role } });

// Invitations (slice 3): token-based, for people who don't have an account
// yet — coexists with inviteWorkspaceMember above (direct-add of an existing
// user), doesn't replace it.
export const createWorkspaceInvitation = (workspaceId, email, role) =>
  apiFetch(`/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { email, role } });
export const listWorkspaceInvitations = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/invitations`);

// Self-service workspace subscription (FEATURE_REQUEST.md). organizationId
// is required here in practice once an account belongs to 2+ orgs — the
// backend 400s without it (resolveCallerOrganization) — so callers must pass
// the currently-selected org once the org switcher exists.
export const listDiscoverableWorkspaces = (organizationId) =>
  apiFetch(`/workspaces/discoverable${organizationId ? `?organizationId=${organizationId}` : ''}`);
export const subscribeToWorkspace = (workspaceId) =>
  apiFetch(`/workspaces/${workspaceId}/subscribe`, { method: 'POST' });

export const listWorkspaceMembers = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/members`);
export const changeWorkspaceMemberRole = (workspaceId, userId, role) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: { role } });
export const removeWorkspaceMember = (workspaceId, userId) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
export const resetWorkspaceMemberPassword = (workspaceId, userId, newPassword) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}/reset-password`, { method: 'POST', body: { newPassword } });

export const archiveWorkspace = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/archive`, { method: 'POST' });
export const unarchiveWorkspace = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/unarchive`, { method: 'POST' });

// New (FEATURE_REQUEST.md entry 1, slice 4).
export const listAllWorkspacesAdmin = () => apiFetch('/workspaces/admin/all');
export const transferWorkspaceOwnership = (workspaceId, username) =>
  apiFetch(`/workspaces/${workspaceId}/transfer-ownership`, { method: 'POST', body: { username } });
export const changeWorkspaceVisibility = (workspaceId, visibility) =>
  apiFetch(`/workspaces/${workspaceId}/visibility`, { method: 'POST', body: { visibility } });
export const updateWorkspaceSettings = (workspaceId, { managersCanArchive }) =>
  apiFetch(`/workspaces/${workspaceId}/settings`, { method: 'POST', body: { managersCanArchive } });

export const listChannels = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/channels`);
export const createChannel = (workspaceId, name, type) =>
  apiFetch(`/workspaces/${workspaceId}/channels`, { method: 'POST', body: { name, type } });
export const joinChannel = (workspaceId, channelId) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/join`, { method: 'POST' });
export const addChannelMember = (workspaceId, channelId, username) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/members`, { method: 'POST', body: { username } });

// FEATURE_REQUEST.md's "channel details panel" entry — the full roster, not
// the mention-autocomplete search endpoint above.
export const listChannelMembers = (workspaceId, channelId) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/members`);

export const createDirectMessage = (targetUserId) =>
  apiFetch('/direct-messages', { method: 'POST', body: { targetUserId } });

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
