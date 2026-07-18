import { apiFetch, API_BASE, getAccessToken, refreshAccessToken } from './client.js';

// The two AI proxy actions (summarize, extract-tasks) return a streamed
// plain-text body, not JSON, so they can't go through apiFetch — but they
// still need the same in-memory-token + silent-refresh-and-retry treatment
// every other authenticated request gets (PROJECT_PLAN.md Section 3).
async function streamPost(path, body, onChunk, { signal, onQueued, _isRetry = false } = {}) {
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
      return streamPost(path, body, onChunk, { signal, onQueued, _isRetry: true });
    }
  }

  if (!res.ok) {
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;
    const error = new Error(data?.error || `Request failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }

  // FEATURE_REQUEST.md entry 2: present when the backend had to queue this
  // request behind another in-flight AI generation (backend/src/llm/
  // concurrencyGate.js) — fetch()'s promise already resolves once headers
  // arrive, well before the streamed body finishes, so this is available
  // immediately, same moment `meta` below is.
  const queuePositionHeader = res.headers.get('x-ai-queue-position');
  if (queuePositionHeader !== null) {
    onQueued?.(Number(queuePositionHeader));
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

export const summarizeChannel = (channelId, onChunk, { limit, onQueued } = {}) =>
  streamPost(`/channels/${channelId}/ai/summarize`, limit ? { limit } : {}, onChunk, { onQueued });

export const extractTasks = (messageId, onChunk, { onQueued } = {}) =>
  streamPost(`/messages/${messageId}/ai/extract-tasks`, {}, onChunk, { onQueued });

// Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry 6).
// `signal` is the one caller-facing addition streamPost's other two callers
// don't need — a digest can run long enough (multiple channels' worth of
// selection + a larger prompt) that the design calls for a real Cancel
// affordance, unlike a single-channel summarize/extract-tasks action.
export const requestWorkspaceDigest = (workspaceId, params, onChunk, { signal, onQueued } = {}) =>
  streamPost('/ai/workspace-digest', { workspaceId, ...params }, onChunk, { signal, onQueued });

export const getAiSettings = () => apiFetch('/ai/settings');
export const updateAiSettings = (patch) => apiFetch('/ai/settings', { method: 'PATCH', body: patch });
