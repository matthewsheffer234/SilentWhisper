import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { connectWs, waitForMessage, sendFrame } from './helpers/wsClient.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';
import { _resetForTests as resetPresence } from '../src/ws/presence.js';
import { _resetForTests as resetWsRateLimiter } from '../src/ws/rateLimiter.js';

// FEATURE_REQUEST.md entry 1: "when a message is committed through either
// REST or WebSocket, enqueue embedding work after the DB commit succeeds."
// Both transports call the shared enqueueEmbeddingJob helper as a sibling
// step right after message creation — this exercises both real call sites
// end to end (not just enqueueEmbeddingJob in isolation), the same way
// mentions.test.js exercises both transports for mention delivery.

let server;
let port;
const openSockets = [];

beforeAll(async () => {
  server = start(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await shutdown(server);
  await destroyResetDbConnection();
});

beforeEach(async () => {
  await resetDb(db);
  resetConnectionRegistry();
  resetPresence();
  resetWsRateLimiter();
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    ws.terminate();
  }
});

async function openAndTrack() {
  const ws = await connectWs(port);
  openSockets.push(ws);
  return ws;
}

// The WS handler broadcasts message_created (which the test client sees
// immediately) before it finishes awaiting the sibling
// extractMentionedUserIds/enqueueEmbeddingJob calls — real, correct
// behavior (those are fire-after-broadcast side effects, not part of the
// client-visible send), but it means a test can't assume the job row exists
// the instant it receives the WS ack. Poll briefly instead of asserting
// synchronously right after the event, the same "don't assume server-side
// side effects are done just because the client saw an ack" instinct
// ws.test.js's own bug-fix history (PROJECT_PLAN.md Section 11) documents.
async function pollUntil(fn, { timeoutMs = 2000, intervalMs = 25 } = {}) {
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

async function createChannelAsMember(owner) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  return { workspaceId: wsRes.body.id, channelId: chRes.body.id };
}

describe('embedding job ingestion', () => {
  test('sending a message via REST enqueues a pending embedding_jobs row', async () => {
    const owner = await signup(app, 'ingestrest0');
    const { channelId } = await createChannelAsMember(owner);

    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hello world' });
    expect(res.status).toBe(201);

    const job = await db('embedding_jobs').where({ message_id: res.body.id }).first();
    expect(job).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
  });

  test('sending a message via WebSocket also enqueues a pending embedding_jobs row', async () => {
    const owner = await signup(app, 'ingestws0');
    const { channelId } = await createChannelAsMember(owner);

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    sendFrame(ws, { type: 'message', channelId, content: 'hi via ws' });
    const created = await waitForMessage(ws, (e) => e.type === 'message_created');

    const job = await pollUntil(() => db('embedding_jobs').where({ message_id: created.message.id }).first());
    expect(job.status).toBe('pending');
  });

  test('a duplicate enqueue for the same message is a no-op, not a duplicate row', async () => {
    const owner = await signup(app, 'ingestdup0');
    const { channelId } = await createChannelAsMember(owner);

    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hello again' });

    const { enqueueEmbeddingJob } = await import('../src/search/embeddingQueue.js');
    await enqueueEmbeddingJob(db, res.body.id);

    const jobs = await db('embedding_jobs').where({ message_id: res.body.id });
    expect(jobs).toHaveLength(1);
  });
});
