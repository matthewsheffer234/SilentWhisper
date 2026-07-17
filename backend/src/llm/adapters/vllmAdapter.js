import { UpstreamError } from '../../errors.js';

// PROJECT_PLAN.md Section 8, Phase 4: "the vLLM adapter alongside it — both
// conforming to the same interface". vLLM's OpenAI-compatible server
// exposes /v1/completions (legacy completions API, which matches this app's
// single-prompt-string interface better than /v1/chat/completions) and
// /v1/models. Not the target environment for this test host (no GPU here),
// but selected via LLM_PROVIDER once this moves to the GPU-backed network —
// see adapterInterface.js for the shape every adapter must conform to.

function authHeaders(settings) {
  return settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
}

function baseUrl(settings) {
  return settings.baseUrl.replace(/\/$/, '');
}

async function generate({ settings, prompt, onChunk, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  // Optional caller-supplied signal (workspace digest, FEATURE_REQUEST.md
  // entry 6) — see ollamaAdapter.js's identical comment.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  try {
    const res = await fetch(`${baseUrl(settings)}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify({
        model: settings.model,
        prompt,
        stream: Boolean(settings.streamingEnabled),
        max_tokens: settings.maxOutputTokens,
        temperature: settings.temperature,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UpstreamError(`vLLM returned HTTP ${res.status}`);
    }

    if (!settings.streamingEnabled || !res.body) {
      const data = await res.json();
      return { text: data.choices?.[0]?.text ?? '' };
    }

    // OpenAI-compatible SSE: lines prefixed "data: <json>", terminated by a
    // literal "data: [DONE]" line.
    let full = '';
    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') {
            newlineIndex = -1;
            break;
          }
          if (payload) {
            const obj = JSON.parse(payload);
            const piece = obj.choices?.[0]?.text ?? '';
            if (piece) {
              full += piece;
              onChunk?.(piece);
            }
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    return { text: full };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError(signal?.aborted ? 'vLLM request was cancelled' : 'vLLM request timed out');
    }
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`vLLM request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

// Semantic search (FEATURE_REQUEST.md entry 1). OpenAI-compatible
// /v1/embeddings: { model, input } -> { data: [{ embedding: [...] }] }.
async function embed({ settings, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const res = await fetch(`${baseUrl(settings)}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify({ model: settings.model, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UpstreamError(`vLLM returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== settings.dimension) {
      throw new UpstreamError(
        `vLLM embedding model "${settings.model}" returned ${Array.isArray(embedding) ? embedding.length : 'no'} dimensions, expected ${settings.dimension}`,
      );
    }
    return { embedding };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError('vLLM embedding request timed out');
    }
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`vLLM embedding request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth({ settings }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(settings.timeoutMs, 10_000));
  try {
    const res = await fetch(`${baseUrl(settings)}/v1/models`, {
      headers: authHeaders(settings),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { healthy: false, message: `HTTP ${res.status}` };
    }
    return { healthy: true, message: 'ok' };
  } catch (err) {
    return { healthy: false, message: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export const vllmAdapter = { generate, checkHealth, embed };
