import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { LLM_SETTING_KEYS, validateSettingsPatch, updateSettings } from '../src/llm/settingsService.js';

// PROJECT_PLAN.md Section 8, Phase 4: "Add tests for ... authorization ...
// provider configuration and health-check reporting ... disabled-provider
// behavior, and audit coverage." Exercises the real HTTP routes end to end
// against a real Postgres, mocking only the outbound provider call
// (global.fetch) — no real Ollama/vLLM is reachable in the test environment.

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
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

  test('rejects a workspace member who is not an ADMIN of any workspace', async () => {
    const admin = await signup(app, 'aiadmin0');
    const member = await signup(app, 'aimember0');
    const workspaceId = await createWorkspace(admin);
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app).get('/api/ai/settings').set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('allows a workspace ADMIN to read settings, including health status', async () => {
    const admin = await signup(app, 'aiadmin1');
    await createWorkspace(admin);

    const res = await request(app).get('/api/ai/settings').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe(config.llm.provider);
    expect(res.body).toHaveProperty('health');
    expect(res.body.apiKey).toBeUndefined();
  });

  test('a workspace ADMIN can update non-secret settings, and it is audited', async () => {
    const admin = await signup(app, 'aiadmin2');
    await createWorkspace(admin);

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
    const admin = await signup(app, 'aiadmin3');
    await createWorkspace(admin);

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
    const owner = await signup(app, 'sumowner0');
    const outsider = await signup(app, 'sumoutsider0');
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

    const owner = await signup(app, 'sumowner1');
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
    const owner = await signup(app, 'sumowner2');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    const res = await request(app)
      .post(`/api/channels/${channelId}/ai/summarize`)
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 503 and audits nothing when the provider is disabled', async () => {
    const owner = await signup(app, 'sumowner3');
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

    const owner = await signup(app, 'taskowner0');
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
    const owner = await signup(app, 'taskowner1');
    const outsider = await signup(app, 'taskoutsider1');
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
    const owner = await signup(app, 'taskowner2');
    const res = await request(app)
      .post('/api/messages/00000000-0000-0000-0000-000000000000/ai/extract-tasks')
      .set(authHeader(owner.accessToken))
      .send({});
    expect(res.status).toBe(404);
  });
});
