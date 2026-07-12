import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

beforeEach(async () => {
  await resetDb(db);
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
    const owner = await signup(app, 'msgowner0');
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
});

describe('message pagination', () => {
  test('returns newest-first and respects the limit', async () => {
    const owner = await signup(app, 'msgowner1');
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
    const owner = await signup(app, 'msgowner2');
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
    const owner = await signup(app, 'msgowner3');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=500`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });

  test('thread replies are fetched separately from the main feed via parentMessageId', async () => {
    const owner = await signup(app, 'msgowner4');
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
    const owner = await signup(app, 'msgowner5');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '' });
    expect(res.status).toBe(400);
  });

  test('rejects a message over the server-side max length', async () => {
    const owner = await signup(app, 'msgowner6');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
  });

  test('accepts a message at exactly the max length', async () => {
    const owner = await signup(app, 'msgowner7');
    const channelId = await createChannel(owner);
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'x'.repeat(10_000) });
    expect(res.status).toBe(201);
  });

  test('rejects a parentMessageId from a different channel', async () => {
    const owner = await signup(app, 'msgowner8');
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
