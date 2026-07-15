import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { runEmbeddingWorkerTick, _resetForTests } from '../src/search/embeddingWorker.js';
import { _resetForTests as resetEmbeddingGate } from '../src/search/embeddingConcurrencyGate.js';

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
