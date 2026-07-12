import { jest } from '@jest/globals';
import { ollamaAdapter } from '../src/llm/adapters/ollamaAdapter.js';
import { vllmAdapter } from '../src/llm/adapters/vllmAdapter.js';
import { disabledAdapter } from '../src/llm/adapters/disabledAdapter.js';
import { UpstreamError, ServiceUnavailableError } from '../src/errors.js';

// PROJECT_PLAN.md Section 8, Phase 4: "Add tests for ... both adapters'
// error handling ... and disabled-provider behavior." No real Ollama/vLLM
// is reachable in the test environment (NODE_ENV=test never touches a real
// provider), so global.fetch is mocked directly rather than hitting a
// network endpoint — same "unit-test the underlying logic directly" pattern
// ws.test.js/presence.test.js already use for rate limiting/presence sweeps.

const baseSettings = {
  baseUrl: 'http://fake-provider:11434',
  model: 'mistral',
  apiKey: null,
  timeoutMs: 5000,
  maxOutputTokens: 128,
  temperature: 0.3,
  streamingEnabled: false,
};

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Fakes just enough of the Fetch API's streaming body shape (`res.body.getReader()`
// returning `{ value, done }` chunks) for the adapters' own parsing loops —
// no real ReadableStream needed.
function makeStreamResponse(lines) {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    read: async () => {
      if (i >= lines.length) return { done: true, value: undefined };
      const chunk = encoder.encode(`${lines[i]}\n`);
      i += 1;
      return { done: false, value: chunk };
    },
  };
  return { ok: true, status: 200, body: { getReader: () => reader } };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ollamaAdapter', () => {
  test('generate returns full text on a non-streaming response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'hello world' }));
    const { text } = await ollamaAdapter.generate({ settings: baseSettings, prompt: 'hi' });
    expect(text).toBe('hello world');
  });

  test('generate streams incremental chunks via onChunk and accumulates full text', async () => {
    const lines = [
      JSON.stringify({ response: 'foo ' }),
      JSON.stringify({ response: 'bar' }),
      JSON.stringify({ response: '', done: true }),
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(makeStreamResponse(lines));
    const chunks = [];
    const { text } = await ollamaAdapter.generate({
      settings: { ...baseSettings, streamingEnabled: true },
      prompt: 'hi',
      onChunk: (c) => chunks.push(c),
    });
    expect(text).toBe('foo bar');
    expect(chunks).toEqual(['foo ', 'bar']);
  });

  test('generate throws UpstreamError on a non-2xx response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({}, 500));
    await expect(ollamaAdapter.generate({ settings: baseSettings, prompt: 'hi' })).rejects.toThrow(UpstreamError);
  });

  test('generate throws UpstreamError on a network failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(ollamaAdapter.generate({ settings: baseSettings, prompt: 'hi' })).rejects.toThrow(UpstreamError);
  });

  test('checkHealth reports healthy when /api/tags responds 200', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ models: [] }));
    const result = await ollamaAdapter.checkHealth({ settings: baseSettings });
    expect(result).toEqual({ healthy: true, message: 'ok' });
  });

  test('checkHealth reports unhealthy (never throws) on a network failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await ollamaAdapter.checkHealth({ settings: baseSettings });
    expect(result.healthy).toBe(false);
  });
});

describe('vllmAdapter', () => {
  test('generate returns full text from an OpenAI-compatible completions response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ choices: [{ text: 'vllm output' }] }));
    const { text } = await vllmAdapter.generate({ settings: baseSettings, prompt: 'hi' });
    expect(text).toBe('vllm output');
  });

  test('generate parses an SSE stream and stops at the [DONE] sentinel', async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ text: 'foo ' }] })}`,
      `data: ${JSON.stringify({ choices: [{ text: 'bar' }] })}`,
      'data: [DONE]',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(makeStreamResponse(lines));
    const chunks = [];
    const { text } = await vllmAdapter.generate({
      settings: { ...baseSettings, streamingEnabled: true },
      prompt: 'hi',
      onChunk: (c) => chunks.push(c),
    });
    expect(text).toBe('foo bar');
    expect(chunks).toEqual(['foo ', 'bar']);
  });

  test('generate throws UpstreamError on a non-2xx response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({}, 503));
    await expect(vllmAdapter.generate({ settings: baseSettings, prompt: 'hi' })).rejects.toThrow(UpstreamError);
  });

  test('checkHealth reports healthy when /v1/models responds 200', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ data: [] }));
    const result = await vllmAdapter.checkHealth({ settings: baseSettings });
    expect(result).toEqual({ healthy: true, message: 'ok' });
  });
});

describe('disabledAdapter', () => {
  test('generate always throws ServiceUnavailableError, never calls out', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(disabledAdapter.generate({ settings: baseSettings, prompt: 'hi' })).rejects.toThrow(
      ServiceUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('checkHealth reports unhealthy without throwing', async () => {
    const result = await disabledAdapter.checkHealth({ settings: baseSettings });
    expect(result).toEqual({ healthy: false, message: 'disabled' });
  });
});
