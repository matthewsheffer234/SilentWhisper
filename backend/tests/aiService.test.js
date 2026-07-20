import { jest } from '@jest/globals';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { runStreamingCompletion } from '../src/llm/aiService.js';

// FEATURE_REQUEST.md entry 2 ("fix the aiRoutes.test.js audit-row race at
// its root"): unit-tests runStreamingCompletion's onBeforeEnd hook directly
// with a fake `res` (same "unit-test the underlying logic directly"
// approach llmAdapters.test.js already establishes for lower-level llm/
// modules), rather than only through the full HTTP+route stack — the
// ordering guarantee and the fail-open behavior on a hook failure are both
// properties of this function itself, not of any one route built on it.

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeFakeRes() {
  const chunks = [];
  return {
    statusCode: null,
    headers: {},
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
    body() {
      return chunks.join('');
    },
  };
}

function fakePromptBuilder({ messages }) {
  return {
    prompt: messages.map((m) => m.content).join('\n'),
    truncatedInputLength: 0,
    wasTruncated: false,
  };
}

beforeEach(async () => {
  await resetDb(db);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('runStreamingCompletion onBeforeEnd', () => {
  test('is awaited before res.end() is called', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'ok' }));
    const res = makeFakeRes();
    let observedResEndedInsideHook = null;

    const onBeforeEnd = jest.fn(async () => {
      observedResEndedInsideHook = res.ended;
    });

    const result = await runStreamingCompletion({
      db,
      res,
      promptBuilder: fakePromptBuilder,
      promptVersionField: 'summaryPromptVersion',
      messages: [{ username: 'alice', content: 'hi' }],
      onBeforeEnd,
    });

    expect(onBeforeEnd).toHaveBeenCalledTimes(1);
    // The whole point of the fix: by the time the hook runs, the response
    // has not been ended yet — so a caller awaiting appendAuditEvent() here
    // is guaranteed to commit before the client's own request promise
    // resolves, closing the "respond before audit commits" race.
    expect(observedResEndedInsideHook).toBe(false);
    expect(res.ended).toBe(true);
    expect(result.text).toBe('ok');
  });

  // The design's explicit "decide, don't leave implicit" call: a rare
  // audit-write failure must not hang the connection or crash the process
  // over content the LLM has already generated (and may have already
  // partially streamed via onChunk) — it fails open, matching
  // enqueueEmbeddingJob's established "rare, narrow, best-effort" precedent.
  test('fails open: the response still completes even if onBeforeEnd rejects', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'hello world' }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeFakeRes();
    const auditError = new Error('simulated audit write failure');
    const onBeforeEnd = jest.fn().mockRejectedValue(auditError);

    const result = await runStreamingCompletion({
      db,
      res,
      promptBuilder: fakePromptBuilder,
      promptVersionField: 'summaryPromptVersion',
      messages: [{ username: 'alice', content: 'hi' }],
      onBeforeEnd,
    });

    expect(onBeforeEnd).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(true);
    expect(res.body()).toBe('hello world');
    expect(result.text).toBe('hello world');
    expect(errorSpy).toHaveBeenCalledWith('Audit write before completing AI response failed:', auditError);
  });

  test('omitting onBeforeEnd behaves exactly as before (optional, backward compatible)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'no hook here' }));
    const res = makeFakeRes();

    const result = await runStreamingCompletion({
      db,
      res,
      promptBuilder: fakePromptBuilder,
      promptVersionField: 'summaryPromptVersion',
      messages: [{ username: 'alice', content: 'hi' }],
    });

    expect(res.ended).toBe(true);
    expect(result.text).toBe('no hook here');
  });
});
