import { apiFetch } from './client.js';

// FEATURE_REQUEST.md entry 3: inline Markdown checkbox tasks. Explicit
// target state, not an implied toggle — mirrors the backend's own
// PATCH .../tasks/:taskIndex contract exactly.
export const toggleTask = (channelId, messageId, taskIndex, checked) =>
  apiFetch(`/channels/${channelId}/messages/${messageId}/tasks/${taskIndex}`, {
    method: 'PATCH',
    body: { checked },
  });

export const getWorkspaceTasks = (workspaceId, { windowDays, cursor, limit } = {}) => {
  const params = new URLSearchParams();
  if (windowDays) params.set('windowDays', windowDays);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/tasks${qs ? `?${qs}` : ''}`);
};
