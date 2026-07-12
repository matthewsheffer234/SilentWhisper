import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { toVectorLiteral } from '../src/search/embeddingService.js';
import { _resetForTests as resetEmbeddingGate } from '../src/search/embeddingConcurrencyGate.js';
import { LLM_SETTING_KEYS } from '../src/llm/settingsService.js';

// FEATURE_REQUEST.md entry 1: "vector search must still filter by channels
// the caller can read before results are returned"; "Log the prompt/query
// length ... not full query text." Mocks global.fetch for the query-embedding
// call (same convention as aiRoutes.test.js) and inserts message_embeddings
// rows directly (bypassing the async worker, which is covered separately by
// embeddingWorker.test.js) so similarity ordering is deterministic.

const DIM = config.embedding.dimension;

// Deliberately simple, orthogonal "spike" vectors so cosine similarity is
// trivially predictable: identical spike -> similarity 1 (distance 0);
// different spike index -> orthogonal, similarity 0 (distance 1).
function spike(index) {
  const v = new Array(DIM).fill(0);
  v[index % DIM] = 1;
  return v;
}

function mockEmbedFetch(vector) {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ embedding: vector }),
  });
}

async function insertEmbedding(messageId, vector) {
  await db('message_embeddings').insert({
    message_id: messageId,
    embedding: db.raw('?::vector', [toVectorLiteral(vector)]),
    model: config.embedding.model,
  });
}

beforeEach(async () => {
  // Must run before resetDb() — same ordering aiRoutes.test.js documents:
  // an app_settings row's updated_by can point at a user resetDb is about to
  // delete, which the FK would otherwise reject.
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await resetDb(db);
  resetEmbeddingGate();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await db.destroy();
  await destroyResetDbConnection();
});

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

async function sendMessage(user, channelId, content, parentMessageId) {
  const res = await request(app)
    .post(`/api/channels/${channelId}/messages`)
    .set(authHeader(user.accessToken))
    .send({ content, parentMessageId });
  return res.body.id;
}

describe('POST /api/search/semantic authorization', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/search/semantic').send({ query: 'hello' });
    expect(res.status).toBe(401);
  });

  test('a non-member of the specified channelId gets 404, not 403', async () => {
    const owner = await signup(app, 'searchowner0');
    const outsider = await signup(app, 'searchoutsider0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    mockEmbedFetch(spike(0));
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(outsider.accessToken))
      .send({ query: 'anything', channelId });
    expect(res.status).toBe(404);
  });

  test('a non-member of the specified workspaceId gets 404, not 403', async () => {
    const owner = await signup(app, 'searchowner1');
    const outsider = await signup(app, 'searchoutsider1');
    const workspaceId = await createWorkspace(owner);

    mockEmbedFetch(spike(0));
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(outsider.accessToken))
      .send({ query: 'anything', workspaceId });
    expect(res.status).toBe(404);
  });

  test('malformed query, limit, and channelId are all rejected with 400', async () => {
    const user = await signup(app, 'searchvalid0');

    const empty = await request(app).post('/api/search/semantic').set(authHeader(user.accessToken)).send({ query: '' });
    expect(empty.status).toBe(400);

    const badLimit = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(user.accessToken))
      .send({ query: 'hi', limit: 0 });
    expect(badLimit.status).toBe(400);

    const badChannel = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(user.accessToken))
      .send({ query: 'hi', channelId: 'not-a-uuid' });
    expect(badChannel.status).toBe(400);
  });
});

describe('POST /api/search/semantic results', () => {
  test('a global query (no scope) never returns a hit from a channel the caller is not in', async () => {
    const alice = await signup(app, 'searchalice0');
    const bob = await signup(app, 'searchbob0');

    const aliceWs = await createWorkspace(alice);
    const aliceChannel = await createChannel(alice, aliceWs);
    const aliceMessageId = await sendMessage(alice, aliceChannel, 'alices private topic');
    await insertEmbedding(aliceMessageId, spike(0));

    const bobWs = await createWorkspace(bob);
    const bobChannel = await createChannel(bob, bobWs);
    const bobMessageId = await sendMessage(bob, bobChannel, 'bobs unrelated topic');
    await insertEmbedding(bobMessageId, spike(1));

    mockEmbedFetch(spike(0));
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(bob.accessToken))
      .send({ query: 'alices private topic' });

    expect(res.status).toBe(200);
    const ids = res.body.results.map((r) => r.messageId);
    expect(ids).not.toContain(aliceMessageId);
  });

  test('results are ordered by similarity, most similar first', async () => {
    const user = await signup(app, 'searchorder0');
    const workspaceId = await createWorkspace(user);
    const channelId = await createChannel(user, workspaceId);

    const closeId = await sendMessage(user, channelId, 'close match');
    await insertEmbedding(closeId, spike(0));
    const farId = await sendMessage(user, channelId, 'far match');
    await insertEmbedding(farId, spike(1));

    mockEmbedFetch(spike(0));
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(user.accessToken))
      .send({ query: 'close match', channelId });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.messageId)).toEqual([closeId, farId]);
    expect(res.body.results[0].similarity).toBeGreaterThan(res.body.results[1].similarity);
  });

  test('a thread-reply hit includes parentMessage', async () => {
    const user = await signup(app, 'searchthread0');
    const workspaceId = await createWorkspace(user);
    const channelId = await createChannel(user, workspaceId);

    const rootId = await sendMessage(user, channelId, 'root question');
    const replyId = await sendMessage(user, channelId, 'reply with the answer', rootId);
    await insertEmbedding(replyId, spike(0));

    mockEmbedFetch(spike(0));
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(user.accessToken))
      .send({ query: 'the answer', channelId });

    expect(res.status).toBe(200);
    const hit = res.body.results.find((r) => r.messageId === replyId);
    expect(hit.parentMessage).toMatchObject({ id: rootId, username: 'searchthread0' });
  });

  test('audits the search with query length and result count, never the raw query text', async () => {
    const user = await signup(app, 'searchaudit0');
    const workspaceId = await createWorkspace(user);
    const channelId = await createChannel(user, workspaceId);
    const messageId = await sendMessage(user, channelId, 'auditable content');
    await insertEmbedding(messageId, spike(0));

    mockEmbedFetch(spike(0));
    const secretQuery = 'a very specific search phrase';
    const res = await request(app)
      .post('/api/search/semantic')
      .set(authHeader(user.accessToken))
      .send({ query: secretQuery, channelId });
    expect(res.status).toBe(200);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SEMANTIC_SEARCH_REQUESTED' }).first();
    expect(auditRow).toBeDefined();
    expect(auditRow.payload.queryLength).toBe(secretQuery.length);
    expect(auditRow.payload.resultCount).toBe(1);
    expect(JSON.stringify(auditRow.payload)).not.toContain(secretQuery);
  });

  test('returns 503 and audits nothing when the provider is disabled', async () => {
    const { validateSettingsPatch, updateSettings } = await import('../src/llm/settingsService.js');
    const user = await signup(app, 'searchdisabled0');
    await updateSettings(db, validateSettingsPatch({ provider: 'disabled' }), user.userId);

    const res = await request(app).post('/api/search/semantic').set(authHeader(user.accessToken)).send({ query: 'hi' });
    expect(res.status).toBe(503);

    const auditRow = await db('audit_logs').where({ action_type: 'AI_SEMANTIC_SEARCH_REQUESTED' }).first();
    expect(auditRow).toBeUndefined();
  });
});
