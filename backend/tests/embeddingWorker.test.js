import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { runEmbeddingWorkerTick, _resetForTests } from '../src/search/embeddingWorker.js';
import { _resetForTests as resetEmbeddingGate } from '../src/search/embeddingConcurrencyGate.js';
import { _resetAnchorCacheForTests } from '../src/search/sentimentService.js';

// FEATURE_REQUEST.md entry 1: "Failed embedding jobs should be retryable and
// observable ... a lightweight DB-backed queue table is acceptable." Exercises
// runEmbeddingWorkerTick directly (not the auto-started interval — see
// index.js's NODE_ENV=test guard) against the real embedding_jobs/
// message_embeddings tables, mocking only the outbound provider call
// (global.fetch), same convention as aiRoutes.test.js.

function makeEmbeddingResponse(embedding) {
  return { ok: true, status: 200, json: async () => ({ embedding }) };
}

function fakeEmbedding(dimension = config.embedding.dimension) {
  return Array.from({ length: dimension }, (_, i) => i / dimension);
}

beforeEach(async () => {
  await resetDb(db);
  _resetForTests();
  resetEmbeddingGate();
  _resetAnchorCacheForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createMessage(username) {
  const owner = await signup(username);
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  const msgRes = await request(app)
    .post(`/api/channels/${chRes.body.id}/messages`)
    .set(authHeader(owner.accessToken))
    .send({ content: 'a message worth embedding' });
  return msgRes.body.id;
}

test('processes a pending job: writes message_embeddings and removes the job row', async () => {
  const messageId = await createMessage('workerok0');
  jest.spyOn(global, 'fetch').mockResolvedValue(makeEmbeddingResponse(fakeEmbedding()));

  await runEmbeddingWorkerTick(db);

  const job = await db('embedding_jobs').where({ message_id: messageId }).first();
  expect(job).toBeUndefined();

  const embeddingRow = await db('message_embeddings').where({ message_id: messageId }).first();
  expect(embeddingRow).toBeDefined();
  expect(embeddingRow.model).toBe(config.embedding.model);
});

// FEATURE_REQUEST.md's "aggregate semantic/sentiment trend" entry:
// message_sentiment_scores is written from the same embedText() call as
// message_embeddings, never a second embedding of the message content —
// the only additional adapter calls this can ever trigger are the two
// anchor-phrase embeddings, and only on the very first message any test (or
// process) ever scores, since sentimentService.js caches them afterward.
test('writes message_sentiment_scores alongside message_embeddings, from the same embedding call', async () => {
  const messageId = await createMessage('workersent0');
  const positiveVec = fakeEmbedding().map((v) => v + 1);
  const negativeVec = fakeEmbedding().map((v) => v - 1);
  const messageVec = fakeEmbedding();
  let fetchCallCount = 0;

  jest.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
    fetchCallCount += 1;
    const body = JSON.parse(opts.body);
    if (body.prompt === config.sentiment.positiveAnchors) return makeEmbeddingResponse(positiveVec);
    if (body.prompt === config.sentiment.negativeAnchors) return makeEmbeddingResponse(negativeVec);
    return makeEmbeddingResponse(messageVec);
  });

  await runEmbeddingWorkerTick(db);

  const sentimentRow = await db('message_sentiment_scores').where({ message_id: messageId }).first();
  expect(sentimentRow).toBeDefined();
  expect(sentimentRow.model).toBe(config.embedding.model);
  expect(typeof sentimentRow.score).toBe('number');
  // 1 call for the message's own embedding + 2 for the (cold-cache) anchors
  // — never a second call re-embedding the message for sentiment scoring.
  expect(fetchCallCount).toBe(3);
});

test('a provider failure leaves the job retryable (pending, attempts incremented), not deleted', async () => {
  const messageId = await createMessage('workerfail0');
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

  await runEmbeddingWorkerTick(db);

  const job = await db('embedding_jobs').where({ message_id: messageId }).first();
  expect(job).toBeDefined();
  expect(job.status).toBe('pending');
  expect(job.attempts).toBe(1);
  expect(job.last_error).toMatch(/ECONNREFUSED|Ollama/i);

  const embeddingRow = await db('message_embeddings').where({ message_id: messageId }).first();
  expect(embeddingRow).toBeUndefined();
});

test('dead-letters (status=failed) once EMBEDDING_MAX_ATTEMPTS is exhausted, and stops consuming it after that', async () => {
  const messageId = await createMessage('workerdead0');
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

  for (let i = 0; i < config.embedding.maxAttempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runEmbeddingWorkerTick(db);
  }

  const job = await db('embedding_jobs').where({ message_id: messageId }).first();
  expect(job.status).toBe('failed');
  expect(job.attempts).toBe(config.embedding.maxAttempts);

  // One more tick must not touch it — 'failed' isn't claimed by the
  // pending-only claim query, so attempts must stay exactly at the cap.
  await runEmbeddingWorkerTick(db);
  const jobAfter = await db('embedding_jobs').where({ message_id: messageId }).first();
  expect(jobAfter.attempts).toBe(config.embedding.maxAttempts);
});

test('claims at most EMBEDDING_WORKER_BATCH_SIZE pending jobs per tick', async () => {
  const ids = [];
  for (let i = 0; i < config.embedding.workerBatchSize + 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    ids.push(await createMessage(`workerbatch${i}`));
  }
  jest.spyOn(global, 'fetch').mockResolvedValue(makeEmbeddingResponse(fakeEmbedding()));

  await runEmbeddingWorkerTick(db);

  const remainingPending = await db('embedding_jobs').where({ status: 'pending' }).count('* as count').first();
  expect(Number(remainingPending.count)).toBe(2);

  const embedded = await db('message_embeddings').whereIn('message_id', ids).count('* as count').first();
  expect(Number(embedded.count)).toBe(config.embedding.workerBatchSize);
});
