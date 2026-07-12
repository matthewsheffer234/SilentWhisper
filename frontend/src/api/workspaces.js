import { apiFetch } from './client.js';

export const listWorkspaces = () => apiFetch('/workspaces');
export const createWorkspace = (name) => apiFetch('/workspaces', { method: 'POST', body: { name } });

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
