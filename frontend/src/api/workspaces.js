import { apiFetch } from './client.js';

export const listWorkspaces = () => apiFetch('/workspaces');
export const createWorkspace = (name) => apiFetch('/workspaces', { method: 'POST', body: { name } });
export const inviteWorkspaceMember = (workspaceId, username, role) =>
  apiFetch(`/workspaces/${workspaceId}/members`, { method: 'POST', body: { username, role } });

export const listWorkspaceMembers = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/members`);
export const changeWorkspaceMemberRole = (workspaceId, userId, role) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: { role } });
export const createWorkspaceUser = (workspaceId, { username, email, password, role }) =>
  apiFetch(`/workspaces/${workspaceId}/users`, { method: 'POST', body: { username, email, password, role } });
export const resetWorkspaceMemberPassword = (workspaceId, userId, newPassword) =>
  apiFetch(`/workspaces/${workspaceId}/members/${userId}/reset-password`, { method: 'POST', body: { newPassword } });

export const listChannels = (workspaceId) => apiFetch(`/workspaces/${workspaceId}/channels`);
export const createChannel = (workspaceId, name, type) =>
  apiFetch(`/workspaces/${workspaceId}/channels`, { method: 'POST', body: { name, type } });
export const joinChannel = (workspaceId, channelId) =>
  apiFetch(`/workspaces/${workspaceId}/channels/${channelId}/join`, { method: 'POST' });

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
