import { UpstreamError } from '../../errors.js';

// PROJECT_PLAN.md Section 8, Phase 4: "Implement the Ollama adapter first
// (this test environment's default)". Talks to Ollama's native
// /api/generate and /api/tags endpoints — see adapterInterface.js for the
// shape every adapter must conform to.

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
  // entry 6 — "allow cancellation without leaving the provider request
  // running indefinitely"). Merged into the same controller as the timeout
  // rather than passed straight to fetch, so either source aborting looks
  // identical downstream.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  try {
    const res = await fetch(`${baseUrl(settings)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify({
        model: settings.model,
        prompt,
        stream: Boolean(settings.streamingEnabled),
        options: {
          temperature: settings.temperature,
          num_predict: settings.maxOutputTokens,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UpstreamError(`Ollama returned HTTP ${res.status}`);
    }

    if (!settings.streamingEnabled || !res.body) {
      const data = await res.json();
      return { text: data.response ?? '' };
    }

    // Ollama's streaming format is newline-delimited JSON objects, each
    // carrying an incremental `response` fragment; the last has done: true.
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
        if (line) {
          const obj = JSON.parse(line);
          if (obj.response) {
            full += obj.response;
            onChunk?.(obj.response);
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    return { text: full };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError(signal?.aborted ? 'Ollama request was cancelled' : 'Ollama request timed out');
    }
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`Ollama request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

// Semantic search (FEATURE_REQUEST.md entry 1). Ollama's native
// /api/embeddings takes a single { model, prompt } and returns
// { embedding: [...] } — not the newer batch /api/embed endpoint, since this
// app only ever embeds one text (a message or a search query) per call.
async function embed({ settings, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const res = await fetch(`${baseUrl(settings)}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify({ model: settings.model, prompt: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UpstreamError(`Ollama returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const embedding = data.embedding;
    if (!Array.isArray(embedding) || embedding.length !== settings.dimension) {
      throw new UpstreamError(
        `Ollama embedding model "${settings.model}" returned ${Array.isArray(embedding) ? embedding.length : 'no'} dimensions, expected ${settings.dimension}`,
      );
    }
    return { embedding };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError('Ollama embedding request timed out');
    }
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`Ollama embedding request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth({ settings }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(settings.timeoutMs, 10_000));
  try {
    const res = await fetch(`${baseUrl(settings)}/api/tags`, {
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

export const ollamaAdapter = { generate, checkHealth, embed };
