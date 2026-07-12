import { apiFetch } from './client.js';

// FEATURE_REQUEST.md entry 1. A single JSON response, not the streaming
// text/plain path api/ai.js uses for summarize/extract-tasks — this endpoint
// returns one { results: [...] } body, so the plain apiFetch helper (with
// its existing in-memory-token + silent-refresh-and-retry handling) applies
// directly.
export const searchSemantic = ({ query, workspaceId, channelId, limit }) =>
  apiFetch('/search/semantic', {
    method: 'POST',
    body: {
      query,
      ...(workspaceId ? { workspaceId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(limit ? { limit } : {}),
    },
  });
