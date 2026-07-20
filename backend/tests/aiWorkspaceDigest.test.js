import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { LLM_SETTING_KEYS, validateSettingsPatch, updateSettings } from '../src/llm/settingsService.js';
import { runMessageSideEffectsWorkerTick } from '../src/workers/messageSideEffectsWorker.js';

// FEATURE_REQUEST.md entry 6, "Cross-channel 'Catch Me Up' workspace
// digests". Same testing shape as aiRoutes.test.js: real HTTP routes against
// a real Postgres, mocking only the outbound provider call (global.fetch).

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function createWorkspace(user) {
  const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
  return res.body.id;
}

async function createChannel(user, workspaceId, name = 'general') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name, type: 'PUBLIC' });
  return res.body.id;
}

async function addMember(workspaceId, channelId, user) {
  await db('workspace_members').insert({ workspace_id: workspaceId, user_id: user.userId, system_role: 'MEMBER' });
  await request(app).post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`).set(authHeader(user.accessToken));
}

beforeEach(async () => {
  // Same ordering reason as aiRoutes.test.js: clear app_settings rows before
  // resetDb() wipes the users those rows' updated_by FKs point at.
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

describe('POST /api/ai/workspace-digest', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/ai/workspace-digest').send({ workspaceId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(401);
  });

  test('a non-member of the workspace gets 404, never a 403', async () => {
    const owner = await signup('digestowner0');
    const outsider = await signup('digestoutsider0');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(outsider.accessToken))
      .send({ workspaceId });
    expect(res.status).toBe(404);
  });

  test('rejects a request with no mentions or selected channel activity in the window', async () => {
    const owner = await signup('digestowner1');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId });
    expect(res.status).toBe(400);
  });

  test('rejects specifying both sinceHours and sinceDays', async () => {
    const owner = await signup('digestowner2');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId, sinceHours: 24, sinceDays: 1 });
    expect(res.status).toBe(400);
  });

  test('rejects a window beyond the configured maximum', async () => {
    const owner = await signup('digestowner3');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId, sinceHours: config.llm.digestMaxWindowHours + 1 });
    expect(res.status).toBe(400);
  });

  test('rejects more than the maximum number of channelIds', async () => {
    const owner = await signup('digestowner4');
    const workspaceId = await createWorkspace(owner);
    const tooMany = Array.from({ length: 11 }, () => '00000000-0000-0000-0000-000000000000');

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId, channelIds: tooMany });
    expect(res.status).toBe(400);
  });

  test('digests an unread mention, streams the result, and audits without raw content', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: '## Urgent Mentions\n- something' }));

    const owner = await signup('digestowner5');
    const member = await signup('digestmember5');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hey @digestmember5 the deploy is done' })
      .expect(201);
    await runMessageSideEffectsWorkerTick(db);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(member.accessToken))
      .send({ workspaceId });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Urgent Mentions');
    expect(res.headers['x-ai-prompt-version']).toBe(config.llm.digestPromptVersion);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_WORKSPACE_DIGEST_REQUESTED' }).orderBy('id', 'desc').first();
    expect(auditRow).toBeDefined();
    expect(auditRow.actor_id).toBe(member.userId);
    expect(auditRow.target_resource).toBe(workspaceId);
    expect(auditRow.payload).toMatchObject({ mentionCount: 1, selectedMessageCount: 1, chunkCount: 1 });
    expect(JSON.stringify(auditRow.payload)).not.toContain('deploy is done');
  });

  test('a read mention is excluded from the digest', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'nothing new' }));

    const owner = await signup('digestowner6');
    const member = await signup('digestmember6');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hey @digestmember6 fyi' })
      .expect(201);
    await runMessageSideEffectsWorkerTick(db);

    await db('mention_notifications').where({ recipient_user_id: member.userId }).update({ read_at: db.fn.now() });

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(member.accessToken))
      .send({ workspaceId });
    // No unread mentions and no channelIds selected -> nothing to digest.
    expect(res.status).toBe(400);
  });

  test('includes messages from an explicitly selected channel the caller is a member of', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'digest text' }));

    const owner = await signup('digestowner7');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'shipping');
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'shipped v2 today' })
      .expect(201);
    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId, channelIds: [channelId] });
    expect(res.status).toBe(200);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_WORKSPACE_DIGEST_REQUESTED' }).orderBy('id', 'desc').first();
    expect(auditRow.payload).toMatchObject({ channelMessageCount: 1, selectedMessageCount: 1 });
  });

  // docs/reviews/security-performance-review-2026-07-19.md Finding 2:
  // selectMentionMessages() must cap its own SQL read (DIGEST_MAX_TOTAL_
  // MESSAGES = 400 in workspaceDigestService.js) rather than materializing
  // every unread mention before the merge step ever trims the result —
  // mentionCount in the audit payload must still report the true total, not
  // just how many survived the cap.
  test('caps the mention scan but still reports the true mention count', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: '## Urgent Mentions\n- lots' }));

    const owner = await signup('digestowner12');
    const member = await signup('digestmember12');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await addMember(workspaceId, channelId, member);

    const totalMentions = 405; // one more batch than DIGEST_MAX_TOTAL_MESSAGES (400)
    const baseTime = Date.now();
    const messageRows = Array.from({ length: totalMentions }, (_, i) => ({
      channel_id: channelId,
      user_id: owner.userId,
      content: `mention-source-${i}`,
      created_at: new Date(baseTime + i * 1000),
    }));
    const insertedMessages = await db('messages').insert(messageRows).returning(['id']);
    const notificationRows = insertedMessages.map((row, i) => ({
      recipient_user_id: member.userId,
      message_id: row.id,
      channel_id: channelId,
      workspace_id: workspaceId,
      mentioned_by_user_id: owner.userId,
      created_at: new Date(baseTime + i * 1000),
    }));
    await db('mention_notifications').insert(notificationRows);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(member.accessToken))
      .send({ workspaceId });
    expect(res.status).toBe(200);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_WORKSPACE_DIGEST_REQUESTED' }).orderBy('id', 'desc').first();
    expect(auditRow.payload).toMatchObject({ mentionCount: totalMentions, selectedMessageCount: 400 });
  });

  test('silently drops a channelId from another workspace instead of leaking its messages', async () => {
    const owner = await signup('digestowner8');
    const workspaceAId = await createWorkspace(owner);
    const workspaceBId = await createWorkspace(owner);
    const foreignChannelId = await createChannel(owner, workspaceBId, 'other-workspace-channel');
    await request(app)
      .post(`/api/channels/${foreignChannelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'secret to workspace B' })
      .expect(201);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId: workspaceAId, channelIds: [foreignChannelId] });
    // Nothing selected: the foreign channel id is silently dropped, and
    // workspace A has no other activity.
    expect(res.status).toBe(400);
  });

  test('silently drops a channelId the caller is not a member of', async () => {
    const owner = await signup('digestowner9');
    const outsider = await signup('digestoutsider9');
    const workspaceId = await createWorkspace(owner);
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: outsider.userId, system_role: 'MEMBER' });
    const privateChannelId = await createChannel(owner, workspaceId, 'private-ish');
    await request(app)
      .post(`/api/channels/${privateChannelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'owner-only channel content' })
      .expect(201);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(outsider.accessToken))
      .send({ workspaceId, channelIds: [privateChannelId] });
    // Outsider is a workspace member but never joined the channel itself.
    expect(res.status).toBe(400);
  });

  test('returns 503 and audits nothing when the provider is disabled', async () => {
    const owner = await signup('digestowner10');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hello' })
      .expect(201);

    await updateSettings(db, validateSettingsPatch({ provider: 'disabled' }), owner.userId);

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(owner.accessToken))
      .send({ workspaceId, channelIds: [channelId] });
    expect(res.status).toBe(503);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_WORKSPACE_DIGEST_REQUESTED' }).orderBy('id', 'desc').first();
    expect(auditRow).toBeUndefined();
  });

  // aiDigestRateLimiter is skip()-ed under NODE_ENV=test — same convention
  // aiProxyRateLimiter/memberSearchLimiter already establish and are
  // themselves left untested for (memberSearch.test.js's comment explains
  // why: a real test run legitimately exceeds any real-traffic ceiling).
  // No 429 test here for the same reason.

  test('an unread mention outside the requested window is excluded', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'digest text' }));

    const owner = await signup('digestowner11');
    const member = await signup('digestmember11');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hey @digestmember11 old news' })
      .expect(201);
    await runMessageSideEffectsWorkerTick(db);
    await db('mention_notifications')
      .where({ recipient_user_id: member.userId })
      .update({ created_at: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    const res = await request(app)
      .post('/api/ai/workspace-digest')
      .set(authHeader(member.accessToken))
      .send({ workspaceId, sinceHours: 24 });
    // The mention is 48h old; the default/explicit 24h window excludes it,
    // and there's no other selected activity.
    expect(res.status).toBe(400);
  });
});
