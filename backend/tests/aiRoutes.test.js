import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { LLM_SETTING_KEYS, validateSettingsPatch, updateSettings } from '../src/llm/settingsService.js';
import { getInFlightCount, getQueueDepth, _resetForTests as resetConcurrencyGate } from '../src/llm/concurrencyGate.js';

// PROJECT_PLAN.md Section 8, Phase 4: "Add tests for ... authorization ...
// provider configuration and health-check reporting ... disabled-provider
// behavior, and audit coverage." Exercises the real HTTP routes end to end
// against a real Postgres, mocking only the outbound provider call
// (global.fetch) — no real Ollama/vLLM is reachable in the test environment.

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// supertest/superagent's Test is lazy: constructing it (even with .send())
// does nothing over the wire until it's awaited/`.then()`-ed — so firing a
// request and *not* immediately awaiting it (needed below to have two
// requests genuinely in flight at once) requires explicitly kicking it off
// via .end(), wrapped back into a plain Promise.
function fireNow(req) {
  return new Promise((resolve, reject) => {
    req.end((err, res) => {
      if (err && !res) reject(err);
      else resolve(res);
    });
  });
}

// Same helper as embeddingIngestion.test.js/mentions.test.js/etc. — a
// request reaching acquireSlot() takes an unpredictable number of
// microtask/macrotask ticks (channel-membership lookup, message-history
// query, ...), so polling the gate's own state is the reliable way to know
// a request has actually arrived there, rather than guessing a tick count.
async function pollUntil(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error('pollUntil timed out');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function createWorkspace(user) {
  const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
  return res.body.id;
}

async function createChannel(user, workspaceId) {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  return res.body.id;
}

beforeEach(async () => {
  // Must run before resetDb(): a PATCH /api/ai/settings in the previous test
  // may have left an app_settings row with updated_by pointing at a user
  // resetDb is about to delete, which the FK (app_settings.updated_by ->
  // users.id) would otherwise reject.
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await resetDb(db);
  resetConcurrencyGate();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await db.destroy();
  await destroyResetDbConnection();
});

describe('GET/PATCH /api/ai/settings authorization', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/ai/settings');
    expect(res.status).toBe(401);
  });

  test('rejects a plain workspace member', async () => {
    const admin = await signup('aiadmin0');
    const member = await signup('aimember0');
    const workspaceId = await createWorkspace(admin);
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app).get('/api/ai/settings').set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  // Security.md, 2026-07-15, HIGH: "Self-Service Workspace Ownership Grants
  // Global Audit/AI Administration" — a workspace OWNER used to be able to
  // read/update global AI settings via requireSystemPermission's OR-fallback,
  // even without is_system_admin. That fallback is removed; being OWNER of a
  // workspace (self-service, anyone can do it via POST /api/workspaces)
  // must no longer grant access to this global, unscoped surface.
  test('rejects a workspace OWNER who is not a system admin', async () => {
    const owner = await signup('aiadmin1');
    await createWorkspace(owner);

    const res = await request(app).get('/api/ai/settings').set(authHeader(owner.accessToken));
    expect(res.status).toBe(403);
  });

  test('a system admin can read settings, including health status', async () => {
    const admin = await seedSystemAdmin('aisysadmin0');

    const res = await request(app).get('/api/ai/settings').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe(config.llm.provider);
    expect(res.body).toHaveProperty('health');
    expect(res.body.apiKey).toBeUndefined();
  });

  test('a system admin can update non-secret settings, and it is audited', async () => {
    const admin = await seedSystemAdmin('aisysadmin1');

    const res = await request(app)
      .patch('/api/ai/settings')
      .set(authHeader(admin.accessToken))
      .send({ model: 'llama3', maxOutputTokens: 300 });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('llama3');
    expect(res.body.maxOutputTokens).toBe(300);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SETTINGS_UPDATED' }).first();
    expect(auditRow).toBeDefined();
    expect(auditRow.actor_id).toBe(admin.userId);
    expect(auditRow.payload).toMatchObject({ model: 'llama3', maxOutputTokens: 300 });
  });

  test('rejects an update with an unknown field or invalid value', async () => {
    const admin = await seedSystemAdmin('aisysadmin2');

    const badField = await request(app)
      .patch('/api/ai/settings')
      .set(authHeader(admin.accessToken))
      .send({ apiKey: 'sneaky' });
    expect(badField.status).toBe(400);

    const badValue = await request(app)
      .patch('/api/ai/settings')
      .set(authHeader(admin.accessToken))
      .send({ provider: 'not-a-real-provider' });
    expect(badValue.status).toBe(400);
  });
});

describe('POST /api/channels/:channelId/ai/summarize', () => {
  test('a non-member gets 404, never a 403 (Section 3, membership existence-hiding)', async () => {
    const owner = await signup('sumowner0');
    const outsider = await signup('sumoutsider0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    const res = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(outsider.accessToken))
      .send({});
    expect(res.status).toBe(404);
  });

  test('a channel member gets a streamed summary, with prompt metadata headers and an audit row', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'Summary: shipped the feature.' }));

    const owner = await signup('sumowner1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'shipped the feature' });

    const res = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toBe('Summary: shipped the feature.');
    expect(res.headers['x-ai-provider']).toBe(config.llm.provider);
    expect(res.headers['x-ai-prompt-version']).toBe(config.llm.summaryPromptVersion);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SUMMARIZE_REQUESTED' }).first();
    expect(auditRow).toBeDefined();
    expect(auditRow.actor_id).toBe(owner.userId);
    expect(auditRow.target_resource).toBe(channelId);
    // Truncated input length, not full message content, is what's logged.
    expect(auditRow.payload).toHaveProperty('truncatedInputLength');
    expect(JSON.stringify(auditRow.payload)).not.toContain('shipped the feature');
  });

  test('rejects summarizing an empty channel', async () => {
    const owner = await signup('sumowner2');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    const res = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 503 and audits nothing when the provider is disabled', async () => {
    const owner = await signup('sumowner3');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hello' });

    await updateSettings(db, validateSettingsPatch({ provider: 'disabled' }), owner.userId);

    const res = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(503);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SUMMARIZE_REQUESTED' }).first();
    expect(auditRow).toBeUndefined();
  });
});

describe('POST /api/messages/:messageId/ai/extract-tasks', () => {
  test('parses the root message plus its replies into the prompt and audits the extraction', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: '- [ ] file the report' }));

    const owner = await signup('taskowner0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    const rootRes = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'can someone file the report' });
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'on it', parentMessageId: rootRes.body.id });

    const res = await request(app)
      .post(`/api/messages/${rootRes.body.id}/ai/extract-tasks`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toBe('- [ ] file the report');

    const auditRow = await db('audit_logs').where({ action_type: 'AI_TASK_EXTRACTION_REQUESTED' }).first();
    expect(auditRow).toBeDefined();
    expect(auditRow.target_resource).toBe(rootRes.body.id);
    expect(auditRow.payload).toMatchObject({ messageCount: 2 });
  });

  test('a non-member of the thread\'s channel gets 404', async () => {
    const owner = await signup('taskowner1');
    const outsider = await signup('taskoutsider1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    const rootRes = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'root message' });

    const res = await request(app)
      .post(`/api/messages/${rootRes.body.id}/ai/extract-tasks`)
      .set(authHeader(outsider.accessToken))
      .send({});
    expect(res.status).toBe(404);
  });

  test('a nonexistent message id gets 404', async () => {
    const owner = await signup('taskowner2');
    const res = await request(app)
      .post('/api/messages/00000000-0000-0000-0000-000000000000/ai/extract-tasks')
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(404);
  });
});

// FEATURE_REQUEST.md entry 2: a request beyond LLM_MAX_CONCURRENT_REQUESTS
// (1 by default here) now waits in a bounded FIFO queue rather than being
// refused outright.
describe('AI concurrency queue', () => {
  test('a second request while one is in-flight gets queued (not immediately rejected) and completes once the first finishes', async () => {
    let resolveFirstFetch;
    const firstFetchGate = new Promise((resolve) => {
      resolveFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await firstFetchGate;
        return makeJsonResponse({ response: 'first summary' });
      }
      return makeJsonResponse({ response: `summary ${fetchCallCount}` });
    });

    const owner = await signup('queueowner0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hello' });

    const firstReq = fireNow(request(app).post(`/api/channels/${channelId}/ai/summarize`).set(authHeader(owner.accessToken)).send({}));
    // Let the first request run up to (and block inside) its mocked fetch
    // call before issuing the second, so the second deterministically finds
    // the slot already held rather than racing for it.
    await pollUntil(() => getInFlightCount() === 1);
    expect(getQueueDepth()).toBe(0);

    const secondReq = fireNow(request(app).post(`/api/channels/${channelId}/ai/summarize`).set(authHeader(owner.accessToken)).send({}));
    // Proves the second request queued rather than being rejected — checked
    // before the first request's generation is ever unblocked below.
    await pollUntil(() => getQueueDepth() === 1);
    expect(getInFlightCount()).toBe(1);

    resolveFirstFetch();
    const [firstRes, secondRes] = await Promise.all([firstReq, secondReq]);
    expect(firstRes.status).toBe(200);
    expect(firstRes.text).toBe('first summary');
    expect(secondRes.status).toBe(200);
    expect(secondRes.headers['x-ai-queue-position']).toBe('1');
    expect(secondRes.text).toBe('summary 2');
    expect(getInFlightCount()).toBe(0);
    expect(getQueueDepth()).toBe(0);
  });

  test('a third and fourth request queue in FIFO order behind an in-flight and an already-queued request', async () => {
    const releasers = [];
    let fetchCallCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          fetchCallCount += 1;
          const callIndex = fetchCallCount;
          releasers.push(() => resolve(makeJsonResponse({ response: `summary ${callIndex}` })));
        }),
    );

    const owner = await signup('queueowner1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hello' });

    const reqs = [];
    for (let i = 0; i < 4; i += 1) {
      reqs.push(fireNow(request(app).post(`/api/channels/${channelId}/ai/summarize`).set(authHeader(owner.accessToken)).send({})));
      // eslint-disable-next-line no-await-in-loop
      await pollUntil(() => getInFlightCount() + getQueueDepth() === i + 1);
    }
    expect(getInFlightCount()).toBe(1);
    expect(getQueueDepth()).toBe(3);

    // Release strictly one at a time, confirming FIFO order: the Nth
    // release must be the one that unblocks the Nth request, not any other.
    // Waits for each generate() call to actually reach the mock (rather than
    // assuming HTTP round-trip vs. microtask timing) before triggering it,
    // then awaits every response together at the end.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pollUntil(() => releasers.length === i + 1);
      releasers[i]();
    }
    const results = await Promise.all(reqs);
    results.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.text).toBe(`summary ${i + 1}`);
    });
    expect(getInFlightCount()).toBe(0);
    expect(getQueueDepth()).toBe(0);
  });

  // Slower than the default 5000ms budget: config.llm.queueMaxDepth + 2 real
  // HTTP round trips through the full auth/membership stack, fired and
  // drained one at a time to keep arrival order deterministic.
  test('a request arriving when the queue is already at capacity still gets an immediate 503', async () => {
    const pendingResolvers = [];
    jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolvers.push(() => resolve(makeJsonResponse({ response: 'drained' })));
        }),
    );

    const owner = await signup('queueowner2');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hello' });

    const reqs = [];
    // 1 in-flight + config.llm.queueMaxDepth queued = queue completely full.
    for (let i = 0; i < 1 + config.llm.queueMaxDepth; i += 1) {
      reqs.push(fireNow(request(app).post(`/api/channels/${channelId}/ai/summarize`).set(authHeader(owner.accessToken)).send({})));
      // eslint-disable-next-line no-await-in-loop
      await pollUntil(() => getInFlightCount() + getQueueDepth() === i + 1);
    }
    expect(getInFlightCount()).toBe(1);
    expect(getQueueDepth()).toBe(config.llm.queueMaxDepth);

    const overflowRes = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(overflowRes.status).toBe(503);
    expect(overflowRes.body.error).toMatch(/at capacity/);
    // Rejected outright — never joined the queue itself.
    expect(getQueueDepth()).toBe(config.llm.queueMaxDepth);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SUMMARIZE_REQUESTED' }).first();
    expect(auditRow).toBeUndefined();

    // Drain every still-pending request so nothing dangles past this test —
    // an unawaited, never-resolving mocked fetch would otherwise leak an
    // open connection into later tests/the process exit. Only the currently
    // in-flight request has actually reached fetch (queued requests haven't
    // gotten there yet), so resolvers must be triggered one at a time as
    // each subsequent request is granted its slot and reaches fetch in turn
    // — resolving whatever exists at a single point in time would leave the
    // rest permanently blocked.
    for (let i = 0; i < reqs.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pollUntil(() => pendingResolvers.length === i + 1);
      pendingResolvers[i]();
    }
    await Promise.all(reqs);
    expect(getInFlightCount()).toBe(0);
    expect(getQueueDepth()).toBe(0);
  }, 15000);
});
