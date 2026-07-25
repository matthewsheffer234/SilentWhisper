import { apiFetch } from './client.js';

// FEATURE_REQUEST.md entry 3: editing a sent message, with a permanent,
// auditable revision history. Mirrors api/tasks.js's toggleTask precedent —
// a REST-only mutation on an already-sent message, not a WebSocket frame
// (message send/receive is the only thing that goes over the socket).
export const editMessage = (channelId, messageId, content) =>
  apiFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: { content },
  });

export const getMessageEditHistory = (channelId, messageId) =>
  apiFetch(`/channels/${channelId}/messages/${messageId}/edits`);
