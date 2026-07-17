import { apiFetch, API_BASE, getAccessToken, refreshAccessToken } from './client.js';

// The two AI proxy actions (summarize, extract-tasks) return a streamed
// plain-text body, not JSON, so they can't go through apiFetch — but they
// still need the same in-memory-token + silent-refresh-and-retry treatment
// every other authenticated request gets (PROJECT_PLAN.md Section 3).
async function streamPost(path, body, onChunk, { signal, _isRetry = false } = {}) {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });

  if (res.status === 401 && !_isRetry) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      return streamPost(path, body, onChunk, { signal, _isRetry: true });
    }
  }

  if (!res.ok) {
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;
    const error = new Error(data?.error || `Request failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }

  const meta = {
    provider: res.headers.get('x-ai-provider'),
    promptVersion: res.headers.get('x-ai-prompt-version'),
    truncatedInputLength: Number(res.headers.get('x-ai-truncated-input-length') || 0),
    wasTruncated: res.headers.get('x-ai-was-truncated') === 'true',
  };

  // Falls back to a single onChunk call with the whole body if the runtime
  // doesn't expose a readable stream reader — the backend still sends a
  // complete response either way (PROJECT_PLAN.md Section 8, Phase 4:
  // "Render streamed or incremental AI text ... when supported").
  if (!res.body || !res.body.getReader) {
    const text = await res.text();
    onChunk?.(text);
    return { text, meta };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    const piece = decoder.decode(value, { stream: true });
    full += piece;
    onChunk?.(piece);
  }
  return { text: full, meta };
}

export const summarizeChannel = (channelId, onChunk, { limit } = {}) =>
  streamPost(`/channels/${channelId}/ai/summarize`, limit ? { limit } : {}, onChunk);

export const extractTasks = (messageId, onChunk) => streamPost(`/messages/${messageId}/ai/extract-tasks`, {}, onChunk);

// Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry 6).
// `signal` is the one caller-facing addition streamPost's other two callers
// don't need — a digest can run long enough (multiple channels' worth of
// selection + a larger prompt) that the design calls for a real Cancel
// affordance, unlike a single-channel summarize/extract-tasks action.
export const requestWorkspaceDigest = (workspaceId, params, onChunk, { signal } = {}) =>
  streamPost('/ai/workspace-digest', { workspaceId, ...params }, onChunk, { signal });

export const getAiSettings = () => apiFetch('/ai/settings');
export const updateAiSettings = (patch) => apiFetch('/ai/settings', { method: 'PATCH', body: patch });
