import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { connectWs, waitForMessage, sendFrame } from './helpers/wsClient.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';
import { _resetForTests as resetPresence } from '../src/ws/presence.js';
import { _resetForTests as resetWsRateLimiter } from '../src/ws/rateLimiter.js';
import { runMessageSideEffectsWorkerTick, _resetForTests } from '../src/workers/messageSideEffectsWorker.js';

// FEATURE_REQUEST.md "hot path splitting" entry: mention-notification
// writing and [[Entity]] linking moved off the message-send path onto this
// worker. Exercises runMessageSideEffectsWorkerTick directly (not the
// auto-started interval — see index.js's NODE_ENV=test guard), the same
// convention tests/embeddingWorker.test.js already established for its
// sibling queue. Unlike embedding jobs, nothing here calls an external
// provider, so there's no fetch to mock — failure/retry/dead-letter is
// exercised via an intentionally unrecognized job_type instead, a real
// (if artificial) error path rather than a mocked one.

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
  _resetForTests();
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

async function createChannelAsMember(owner, { type = 'PUBLIC' } = {}) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type });
  return { workspaceId: wsRes.body.id, channelId: chRes.body.id };
}

async function addMember(workspaceId, channelId, user) {
  await db('workspace_members').insert({ workspace_id: workspaceId, user_id: user.userId, system_role: 'MEMBER' });
  await request(app)
    .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
    .set(authHeader(user.accessToken));
}

// The WS handler broadcasts message_created before finishing the awaited
// enqueueMessageSideEffectJobs call — a client receiving that frame proves
// nothing about whether the job row has actually landed yet (same instinct
// as embeddingIngestion.test.js's identically-named helper).
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

describe('job enqueueing at both send call sites', () => {
  test('sending via REST immediately enqueues both jobs, pending, before any tick runs', async () => {
    const owner = await signup('msejobenqueuerest0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);

    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'Deploy [[Server Alpha]] today' });

    const jobs = await db('message_side_effect_jobs').where({ message_id: res.body.id }).orderBy('job_type');
    expect(jobs.map((j) => j.job_type)).toEqual(['ENTITY_LINK', 'NOTIFICATION']);
    expect(jobs.every((j) => j.status === 'pending')).toBe(true);
    // Proves the work really did move off the request path, not just that
    // it's fast — nothing has run yet.
    expect(await db('entities').where({ workspace_id: workspaceId })).toHaveLength(0);
  });

  test('sending via WebSocket also enqueues both jobs', async () => {
    const owner = await signup('msejobenqueuews0');
    const { channelId } = await createChannelAsMember(owner);

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    sendFrame(ws, { type: 'message', channelId, content: 'Ship [[Project Ares]] tonight' });
    const created = await waitForMessage(ws, (e) => e.type === 'message_created');

    const jobs = await pollUntil(async () => {
      const rows = await db('message_side_effect_jobs').where({ message_id: created.message.id });
      return rows.length === 2 ? rows : null;
    });
    expect(jobs.map((j) => j.job_type).sort()).toEqual(['ENTITY_LINK', 'NOTIFICATION']);

    // Only after an explicit tick does the entity actually get created —
    // closing the one gap no prior test covered: entity linking via the WS
    // send path specifically (tests/entities.test.js only ever sends via
    // REST).
    await runMessageSideEffectsWorkerTick(db);
    const entity = await db('entities').where({ normalized_name: 'project ares' }).first();
    expect(entity).toBeDefined();
  });
});

describe('processing a NOTIFICATION job', () => {
  test('writes a mention_notifications row, pushes a live mention frame, and removes the job row', async () => {
    const owner = await signup('msejobnotify0');
    const member = await signup('msejobnotifymember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const memberWs = await openAndTrack();
    sendFrame(memberWs, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(memberWs, (e) => e.type === 'authenticated');

    const mentionPromise = waitForMessage(memberWs, (e) => e.type === 'mention');
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: `hey @${member.username}` });

    // Nothing pushed yet — the whole point of this entry is that the
    // request/response cycle above doesn't do this work inline anymore.
    const beforeTick = await db('mention_notifications').where({ message_id: res.body.id });
    expect(beforeTick).toHaveLength(0);

    await runMessageSideEffectsWorkerTick(db);

    const mention = await mentionPromise;
    expect(mention.channelId).toBe(channelId);
    expect(mention.mentionedBy).toBe(owner.username);

    const notificationRow = await db('mention_notifications').where({ message_id: res.body.id }).first();
    expect(notificationRow).toBeDefined();
    expect(notificationRow.recipient_user_id).toBe(member.userId);

    const job = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'NOTIFICATION' }).first();
    expect(job).toBeUndefined();
  });

  test('a message with no mentions still processes and removes the job row, with no notification row', async () => {
    const owner = await signup('msejobnomention0');
    const { channelId } = await createChannelAsMember(owner);

    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'no mentions here' });

    await runMessageSideEffectsWorkerTick(db);

    const job = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'NOTIFICATION' }).first();
    expect(job).toBeUndefined();
    const notificationRows = await db('mention_notifications').where({ message_id: res.body.id });
    expect(notificationRows).toHaveLength(0);
  });
});

describe('processing an ENTITY_LINK job', () => {
  test('creates the entity and message link, then removes the job row', async () => {
    const owner = await signup('msejobentity0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);

    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'Deploy [[Server Alpha]] today' });

    const beforeTick = await db('entities').where({ workspace_id: workspaceId });
    expect(beforeTick).toHaveLength(0);

    await runMessageSideEffectsWorkerTick(db);

    const entity = await db('entities').where({ workspace_id: workspaceId }).first();
    expect(entity).toBeDefined();
    expect(entity.canonical_name).toBe('Server Alpha');

    const link = await db('message_entities').where({ message_id: res.body.id, entity_id: entity.id }).first();
    expect(link).toBeDefined();

    const job = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'ENTITY_LINK' }).first();
    expect(job).toBeUndefined();
  });

  test('a DIRECT message never gets an ENTITY_LINK job enqueued at all', async () => {
    const alice = await signup('msejobdm0a');
    const bob = await signup('msejobdm0b');
    const dm = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: bob.userId });

    const res = await request(app)
      .post(`/api/channels/${dm.body.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: 'Private [[Server Alpha]]' });

    const entityLinkJob = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'ENTITY_LINK' });
    expect(entityLinkJob).toHaveLength(0);
    // NOTIFICATION is still enqueued for DMs (mention_notifications.workspace_id is nullable).
    const notificationJob = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'NOTIFICATION' });
    expect(notificationJob).toHaveLength(1);
  });
});

describe('retry and dead-letter', () => {
  test('a job with an unrecognized job_type is retried (pending, attempts incremented), not silently dropped', async () => {
    const owner = await signup('msejobretry0');
    const { channelId } = await createChannelAsMember(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'whatever' });

    // Real messages never get a job_type other than NOTIFICATION/ENTITY_LINK
    // (services/messageSideEffectsQueue.js only ever writes those two) — this
    // simulates a corrupted/future-incompatible row to exercise the retry
    // path deterministically, without needing to mock anything.
    await db('message_side_effect_jobs')
      .insert({ message_id: res.body.id, job_type: 'BOGUS' })
      .onConflict(['message_id', 'job_type'])
      .ignore();

    await runMessageSideEffectsWorkerTick(db);

    const job = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'BOGUS' }).first();
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toMatch(/Unknown job_type/);
  });

  test('dead-letters (status=failed) once maxAttempts is exhausted, and stops consuming it after that', async () => {
    const owner = await signup('msejobdead0');
    const { channelId } = await createChannelAsMember(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'whatever' });
    await db('message_side_effect_jobs')
      .insert({ message_id: res.body.id, job_type: 'BOGUS' })
      .onConflict(['message_id', 'job_type'])
      .ignore();

    for (let i = 0; i < config.messageSideEffects.maxAttempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runMessageSideEffectsWorkerTick(db);
    }

    const job = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'BOGUS' }).first();
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(config.messageSideEffects.maxAttempts);

    // One more tick must not touch it — 'failed' isn't claimed by the
    // pending-only claim query, so attempts must stay exactly at the cap.
    await runMessageSideEffectsWorkerTick(db);
    const jobAfter = await db('message_side_effect_jobs').where({ message_id: res.body.id, job_type: 'BOGUS' }).first();
    expect(jobAfter.attempts).toBe(config.messageSideEffects.maxAttempts);
  });
});

describe('batching', () => {
  test('claims at most workerBatchSize pending jobs per tick', async () => {
    // One send per user, not workerBatchSize+2 sends from a single one —
    // isMessageRateLimited is per-user (config.ws.maxMessagesPerWindow,
    // default 10), and this loop's length is itself derived from
    // workerBatchSize (also defaulting to 10), so a single sender would trip
    // that limit partway through and fail the request, not just be slow.
    const ids = [];
    let workspaceId;
    let channelId;
    for (let i = 0; i < config.messageSideEffects.workerBatchSize + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const sender = await signup(`msejobbatchuser${i}`);
      if (i === 0) {
        // eslint-disable-next-line no-await-in-loop
        ({ workspaceId, channelId } = await createChannelAsMember(sender));
      } else {
        // eslint-disable-next-line no-await-in-loop
        await addMember(workspaceId, channelId, sender);
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set(authHeader(sender.accessToken))
        .send({ content: `msg ${i}` });
      ids.push(res.body.id);
    }

    // Each PUBLIC-channel message enqueues *two* jobs (NOTIFICATION +
    // ENTITY_LINK, since workspaceId is truthy) regardless of whether its
    // content has any mentions/[[Entity]] tokens — that gate lives inside
    // each job's own processing, not at enqueue time. So total job count is
    // 2x message count, not 1x; compute the expected remainder from the
    // real total rather than assuming a fixed multiplier.
    const totalJobsRow = await db('message_side_effect_jobs').count('* as count').first();
    const totalJobs = Number(totalJobsRow.count);
    expect(totalJobs).toBe(ids.length * 2);

    await runMessageSideEffectsWorkerTick(db);

    const remainingPending = await db('message_side_effect_jobs').where({ status: 'pending' }).count('* as count').first();
    expect(Number(remainingPending.count)).toBe(totalJobs - config.messageSideEffects.workerBatchSize);

    const stillQueuedIds = await db('message_side_effect_jobs').where({ status: 'pending' }).pluck('message_id');
    expect(stillQueuedIds.every((id) => ids.includes(id))).toBe(true);
  });
});
