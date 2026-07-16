import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { _resetForTests as resetMessageRateLimiter } from '../src/ws/rateLimiter.js';

beforeEach(async () => {
  await resetDb(db);
  resetMessageRateLimiter();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createChannel(owner) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  return chRes.body.id;
}

describe('message author display', () => {
  test('both the history list and a fresh send include the sender username', async () => {
    const owner = await signup('msgowner0');
    const channelId = await createChannel(owner);

    const sendRes = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hi' });
    expect(sendRes.body.username).toBe('msgowner0');

    const listRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(listRes.body[0].username).toBe('msgowner0');
  });

  // FEATURE_REQUEST.md's "display names as the primary identity" entry: the
  // author payload is additive ({userId, username, displayName}), not a
  // replacement — a distinct display name proves the field reflects the
  // stored value end to end (JWT claim on send, a fresh join on history
  // list), not just username echoed back under a second key.
  test('both the send response and the history list include a distinct sender display name', async () => {
    const owner = await signup('msgowner1', { displayName: 'Message Owner One' });
    const channelId = await createChannel(owner);

    const sendRes = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hi' });
    expect(sendRes.body.displayName).toBe('Message Owner One');

    const listRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(listRes.body[0].displayName).toBe('Message Owner One');
  });
});

describe('message pagination', () => {
  test('returns newest-first and respects the limit', async () => {
    const owner = await signup('msgowner1');
    const channelId = await createChannel(owner);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set(authHeader(owner.accessToken))
        .send({ content: `message ${i}` });
    }

    const res = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=3`)
      .set(authHeader(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].content).toBe('message 4');
    expect(res.body[2].content).toBe('message 2');
  });

  test('the before cursor paginates correctly with no duplicates or gaps', async () => {
    const owner = await signup('msgowner2');
    const channelId = await createChannel(owner);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set(authHeader(owner.accessToken))
        .send({ content: `message ${i}` });
    }

    const page1 = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=2`)
      .set(authHeader(owner.accessToken));
    expect(page1.body.map((m) => m.content)).toEqual(['message 4', 'message 3']);

    const oldestInPage1 = page1.body[page1.body.length - 1].createdAt;
    const page2 = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=2&before=${encodeURIComponent(oldestInPage1)}`)
      .set(authHeader(owner.accessToken));
    expect(page2.body.map((m) => m.content)).toEqual(['message 2', 'message 1']);
  });

  test('rejects a limit outside 1-100', async () => {
    const owner = await signup('msgowner3');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=500`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });

  test('thread replies are fetched separately from the main feed via parentMessageId', async () => {
    const owner = await signup('msgowner4');
    const channelId = await createChannel(owner);

    const root = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'root message' });

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'a reply', parentMessageId: root.body.id });

    const mainFeed = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(mainFeed.body).toHaveLength(1);
    expect(mainFeed.body[0].content).toBe('root message');

    const thread = await request(app)
      .get(`/api/channels/${channelId}/messages?parentMessageId=${root.body.id}`)
      .set(authHeader(owner.accessToken));
    expect(thread.body).toHaveLength(1);
    expect(thread.body[0].content).toBe('a reply');
  });
});

describe('message length limits', () => {
  test('rejects an empty message', async () => {
    const owner = await signup('msgowner5');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '' });
    expect(res.status).toBe(400);
  });

  test('rejects a message over the server-side max length', async () => {
    const owner = await signup('msgowner6');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
  });

  test('accepts a message at exactly the max length', async () => {
    const owner = await signup('msgowner7');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'x'.repeat(10_000) });
    expect(res.status).toBe(201);
  });

  test('rejects a parentMessageId from a different channel', async () => {
    const owner = await signup('msgowner8');
    const channelId1 = await createChannel(owner);
    const channelId2 = await createChannel(owner);

    const root = await request(app)
      .post(`/api/channels/${channelId1}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'root in channel 1' });

    const res = await request(app)
      .post(`/api/channels/${channelId2}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'cross-channel reply attempt', parentMessageId: root.body.id });
    expect(res.status).toBe(400);
  });
});

describe('REST send rate limiting (Section 3, Rate Limiting & Abuse Prevention)', () => {
  test('a single user flooding the REST endpoint eventually gets 429, not an unbounded flood', async () => {
    const owner = await signup('msgratelimited0');
    const channelId = await createChannel(owner);

    const statuses = [];
    for (let i = 0; i < config.ws.maxMessagesPerWindow + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set(authHeader(owner.accessToken))
        .send({ content: `flood ${i}` });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(config.ws.maxMessagesPerWindow);
    expect(statuses.slice(config.ws.maxMessagesPerWindow)).toEqual([429, 429]);
  });

  test('the limit is shared across users — one user hitting it does not affect another', async () => {
    const userA = await signup('msgratelimited1');
    const userB = await signup('msgratelimited2');
    const channelId = await createChannel(userA);
    // userB needs to be a member of the same channel to send to it.
    await db('channel_members').insert({ channel_id: channelId, user_id: userB.userId });

    for (let i = 0; i < config.ws.maxMessagesPerWindow; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(userA.accessToken)).send({ content: `a${i}` });
    }
    const userAExtra = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(userA.accessToken))
      .send({ content: 'one too many' });
    expect(userAExtra.status).toBe(429);

    const userBFirst = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(userB.accessToken))
      .send({ content: 'userB should be unaffected' });
    expect(userBFirst.status).toBe(201);
  });
});
