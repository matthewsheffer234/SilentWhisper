import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { _resetForTests as resetMessageRateLimiter } from '../src/ws/rateLimiter.js';
import { runMessageSideEffectsWorkerTick, _resetForTests as resetSideEffectsWorker } from '../src/workers/messageSideEffectsWorker.js';

beforeEach(async () => {
  await resetDb(db);
  resetMessageRateLimiter();
  resetSideEffectsWorker();
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

describe('message reply counts', () => {
  test('a message with no replies has replyCount 0 in the main feed', async () => {
    const owner = await signup('msgreplycount0');
    const channelId = await createChannel(owner);
    await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'root' });

    const listRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(listRes.body[0].replyCount).toBe(0);
  });

  test('replyCount in the main feed reflects the number of replies posted', async () => {
    const owner = await signup('msgreplycount1');
    const channelId = await createChannel(owner);
    const root = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'root' });

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'reply one', parentMessageId: root.body.id });
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'reply two', parentMessageId: root.body.id });

    const listRes = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].replyCount).toBe(2);
  });

  test('replies themselves report replyCount 0 — threading is flat, replies have no children', async () => {
    const owner = await signup('msgreplycount2');
    const channelId = await createChannel(owner);
    const root = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'root' });
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'a reply', parentMessageId: root.body.id });

    const threadRes = await request(app)
      .get(`/api/channels/${channelId}/messages?parentMessageId=${root.body.id}`)
      .set(authHeader(owner.accessToken));
    expect(threadRes.body).toHaveLength(1);
    expect(threadRes.body[0].replyCount).toBe(0);
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

// FEATURE_REQUEST.md entry 3: inline Markdown checkbox tasks.
describe('task checkbox toggle (PATCH .../tasks/:taskIndex)', () => {
  async function sendTaskMessage(owner, channelId, content = '- [ ] first task\n- [ ] second task [owner:: @al]') {
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content });
    return res.body.id;
  }

  test('toggling to checked persists and is idempotent to read back', async () => {
    const owner = await signup('taskowner0');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('- [x] first task\n- [ ] second task [owner:: @al]');

    const history = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(history.body[0].content).toBe('- [x] first task\n- [ ] second task [owner:: @al]');
  });

  test('only the targeted index changes — the other task line is untouched', async () => {
    const owner = await signup('taskowner1');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/1`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('- [ ] first task\n- [x] second task [owner:: @al]');
  });

  test('explicit target state converges regardless of prior state — setting checked:true twice is a no-op the second time', async () => {
    const owner = await signup('taskowner2');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] only task');

    const first = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    const second = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.content).toBe(first.body.content);
  });

  test('two concurrent toggles of the same message converge on their respective requested states, not a lost update', async () => {
    const owner = await signup('taskowner3');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] first task\n- [ ] second task');

    const [resA, resB] = await Promise.all([
      request(app)
        .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
        .set(authHeader(owner.accessToken))
        .send({ checked: true }),
      request(app)
        .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/1`)
        .set(authHeader(owner.accessToken))
        .send({ checked: true }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const history = await request(app)
      .get(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken));
    expect(history.body[0].content).toBe('- [x] first task\n- [x] second task');
  });

  test('a non-member of the channel gets the existing existence-hiding 404', async () => {
    const owner = await signup('taskowner4');
    const outsider = await signup('taskoutsider0');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(outsider.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(404);
  });

  test('a channelId/messageId mismatch across channels 404s the same way, not a 400/403', async () => {
    const owner = await signup('taskowner5');
    const channelId1 = await createChannel(owner);
    const channelId2 = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId1);

    const res = await request(app)
      .patch(`/api/channels/${channelId2}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(404);
  });

  test('an out-of-range taskIndex 404s', async () => {
    const owner = await signup('taskowner6');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] only one task');

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/7`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(404);
  });

  test('rejects a non-boolean checked value with 400', async () => {
    const owner = await signup('taskowner7');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] only one task');

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: 'yes' });
    expect(res.status).toBe(400);
  });

  test('records a MESSAGE_TASK_TOGGLED audit event with ids/counts, never message content', async () => {
    const owner = await signup('taskowner8');
    const channelId = await createChannel(owner);
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] only one task');

    await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });

    const row = await db('audit_logs').where({ action_type: 'MESSAGE_TASK_TOGGLED' }).first();
    expect(row).toBeTruthy();
    expect(row.target_resource).toBe(messageId);
    expect(row.payload).toEqual({ channelId, taskIndex: 0, checked: true });
  });

  test('toggling in an archived workspace is rejected', async () => {
    const owner = await signup('taskowner10');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const chRes = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'general', type: 'PUBLIC' });
    const channelId = chRes.body.id;
    const messageId = await sendTaskMessage(owner, channelId, '- [ ] only one task');

    await db('workspaces').where({ id: wsRes.body.id }).update({ archived_at: new Date() });

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}/tasks/0`)
      .set(authHeader(owner.accessToken))
      .send({ checked: true });
    expect(res.status).toBe(409);
  });
});

// FEATURE_REQUEST.md entry 3: editing a sent message, with a permanent,
// auditable revision history.
describe('message editing (PATCH /channels/:channelId/messages/:messageId)', () => {
  async function sendMessage(owner, channelId, content = 'original content') {
    const res = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content });
    return res.body.id;
  }

  test('the author can edit their own message; content/editedAt update, and the history list reflects it', async () => {
    const owner = await signup('editowner0');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId, 'original content');

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'corrected content' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('corrected content');
    expect(res.body.editedAt).toBeTruthy();

    const history = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken));
    expect(history.body[0].content).toBe('corrected content');
    expect(history.body[0].editedAt).toBeTruthy();
  });

  test('a fresh, never-edited message has editedAt: null in both the send response and the history list', async () => {
    const owner = await signup('editowner1');
    const channelId = await createChannel(owner);

    const sendRes = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hi' });
    expect(sendRes.body.editedAt).toBeNull();

    const history = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken));
    expect(history.body[0].editedAt).toBeNull();
  });

  test('a channel member who is not the author gets 403, not 404 — they already legitimately see this message', async () => {
    const owner = await signup('editowner2');
    const bob = await signup('editbob2');
    const channelId = await createChannel(owner);
    await db('channel_members').insert({ channel_id: channelId, user_id: bob.userId });
    const messageId = await sendMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(bob.accessToken))
      .send({ content: 'bob rewrites it' });
    expect(res.status).toBe(403);

    const unchanged = await db('messages').where({ id: messageId }).first('content');
    expect(unchanged.content).toBe('original content');
  });

  test('a non-member of the channel gets the existing existence-hiding 404', async () => {
    const owner = await signup('editowner3');
    const outsider = await signup('editoutsider3');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(outsider.accessToken))
      .send({ content: 'should not land' });
    expect(res.status).toBe(404);
  });

  test('a channelId/messageId mismatch across channels 404s the same way, not a 400/403', async () => {
    const owner = await signup('editowner4');
    const channelId1 = await createChannel(owner);
    const channelId2 = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId1);

    const res = await request(app)
      .patch(`/api/channels/${channelId2}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'wrong channel' });
    expect(res.status).toBe(404);
  });

  test('editing outside the configured time window is rejected with 400', async () => {
    const owner = await signup('editowner5');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId);
    await db('messages')
      .where({ id: messageId })
      .update({ created_at: new Date(Date.now() - (config.messages.editWindowMinutes + 1) * 60 * 1000) });

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'too late' });
    expect(res.status).toBe(400);

    const unchanged = await db('messages').where({ id: messageId }).first('content');
    expect(unchanged.content).toBe('original content');
  });

  test('editing again does not reset the window — the anchor is created_at, and an edit never touches it', async () => {
    const owner = await signup('editowner6');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId);
    const original = await db('messages').where({ id: messageId }).first('created_at');

    const first = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'edited once' });
    expect(first.status).toBe(200);

    const afterFirstEdit = await db('messages').where({ id: messageId }).first('created_at');
    expect(afterFirstEdit.created_at.getTime()).toBe(original.created_at.getTime());

    // Push created_at itself outside the window and confirm a further edit
    // is rejected — proving the check is anchored to created_at (just
    // proven unchanged by the first edit above), not silently refreshed by
    // whichever edit most recently succeeded.
    await db('messages')
      .where({ id: messageId })
      .update({ created_at: new Date(Date.now() - (config.messages.editWindowMinutes + 1) * 60 * 1000) });

    const second = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'edited twice' });
    expect(second.status).toBe(400);
  });

  test('editing in an archived workspace is rejected', async () => {
    const owner = await signup('editowner7');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const chRes = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'general', type: 'PUBLIC' });
    const channelId = chRes.body.id;
    const messageId = await sendMessage(owner, channelId);

    await db('workspaces').where({ id: wsRes.body.id }).update({ archived_at: new Date() });

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'archived edit' });
    expect(res.status).toBe(409);
  });

  test('rejects an empty edit with 400, same validation as sending', async () => {
    const owner = await signup('editowner8');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId);

    const res = await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: '' });
    expect(res.status).toBe(400);
  });

  test('records a MESSAGE_EDITED audit event with lengths only, never the old or new text', async () => {
    const owner = await signup('editowner9');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId, 'short');

    await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'a fair bit longer than before' });

    const row = await db('audit_logs').where({ action_type: 'MESSAGE_EDITED' }).first();
    expect(row).toBeTruthy();
    expect(row.target_resource).toBe(messageId);
    expect(row.payload).toEqual({ channelId, contentLengthBefore: 'short'.length, contentLengthAfter: 'a fair bit longer than before'.length });
    expect(JSON.stringify(row.payload)).not.toContain('short');
    expect(JSON.stringify(row.payload)).not.toContain('longer than before');
  });

  test('each edit inserts exactly one message_edits row holding the pre-edit content; rows accumulate and are never mutated', async () => {
    const owner = await signup('editowner10');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId, 'version one');

    await request(app).patch(`/api/channels/${channelId}/messages/${messageId}`).set(authHeader(owner.accessToken)).send({ content: 'version two' });
    await request(app).patch(`/api/channels/${channelId}/messages/${messageId}`).set(authHeader(owner.accessToken)).send({ content: 'version three' });

    const rows = await db('message_edits').where({ message_id: messageId }).orderBy('edited_at', 'asc');
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe('version one');
    expect(rows[1].content).toBe('version two');
    expect(rows[0].edited_by).toBe(owner.userId);

    const current = await db('messages').where({ id: messageId }).first('content');
    expect(current.content).toBe('version three');
  });

  test('editing to add a [[Entity]] mention links it; editing again to remove it un-links it, not leaving a stale reference', async () => {
    const owner = await signup('editowner11');
    const channelId = await createChannel(owner);
    const messageId = await sendMessage(owner, channelId, 'no entities here');
    await runMessageSideEffectsWorkerTick(db);
    expect(await db('message_entities').where({ message_id: messageId })).toHaveLength(0);

    await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'now mentioning [[Server Alpha]]' });
    await runMessageSideEffectsWorkerTick(db);
    const entity = await db('entities').where({ normalized_name: 'server alpha' }).first();
    expect(entity).toBeTruthy();
    expect(await db('message_entities').where({ message_id: messageId, entity_id: entity.id })).toHaveLength(1);

    await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'no longer mentioning it' });
    await runMessageSideEffectsWorkerTick(db);
    expect(await db('message_entities').where({ message_id: messageId })).toHaveLength(0);
  });

  test('editing to add a @mention notifies the newly-mentioned user; a mention present before and after is not re-notified', async () => {
    const owner = await signup('editowner12');
    const alice = await signup('editalice12');
    const bob = await signup('editbob12');
    const channelId = await createChannel(owner);
    await db('channel_members').insert([
      { channel_id: channelId, user_id: alice.userId },
      { channel_id: channelId, user_id: bob.userId },
    ]);
    const messageId = await sendMessage(owner, channelId, `already mentions @${alice.username}`);
    await runMessageSideEffectsWorkerTick(db);
    expect(await db('mention_notifications').where({ recipient_user_id: alice.userId, message_id: messageId })).toHaveLength(1);
    expect(await db('mention_notifications').where({ recipient_user_id: bob.userId, message_id: messageId })).toHaveLength(0);

    await request(app)
      .patch(`/api/channels/${channelId}/messages/${messageId}`)
      .set(authHeader(owner.accessToken))
      .send({ content: `already mentions @${alice.username} and now also @${bob.username}` });
    await runMessageSideEffectsWorkerTick(db);

    // Alice was already notified before the edit — still exactly one row,
    // not a second one from the re-run.
    expect(await db('mention_notifications').where({ recipient_user_id: alice.userId, message_id: messageId })).toHaveLength(1);
    // Bob is newly mentioned — a fresh notification.
    expect(await db('mention_notifications').where({ recipient_user_id: bob.userId, message_id: messageId })).toHaveLength(1);
  });
});

// FEATURE_REQUEST.md entry 3: the revision-history endpoint behind the
// "(edited)" tag.
describe('message edit history (GET /channels/:channelId/messages/:messageId/edits)', () => {
  test('returns every prior revision newest-first, with the author and timestamp of each edit', async () => {
    const owner = await signup('histowner0');
    const channelId = await createChannel(owner);
    const sendRes = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'v1' });
    const messageId = sendRes.body.id;
    await request(app).patch(`/api/channels/${channelId}/messages/${messageId}`).set(authHeader(owner.accessToken)).send({ content: 'v2' });
    await request(app).patch(`/api/channels/${channelId}/messages/${messageId}`).set(authHeader(owner.accessToken)).send({ content: 'v3' });

    const res = await request(app).get(`/api/channels/${channelId}/messages/${messageId}/edits`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.content)).toEqual(['v2', 'v1']);
    expect(res.body[0].username).toBe(owner.username);
    expect(res.body[0].editedAt).toBeTruthy();
  });

  test('a never-edited message has an empty history', async () => {
    const owner = await signup('histowner1');
    const channelId = await createChannel(owner);
    const sendRes = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hi' });

    const res = await request(app).get(`/api/channels/${channelId}/messages/${sendRes.body.id}/edits`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('any channel member can view history, not just the author — seeing a prior version discloses nothing new', async () => {
    const owner = await signup('histowner2');
    const bob = await signup('histbob2');
    const channelId = await createChannel(owner);
    await db('channel_members').insert({ channel_id: channelId, user_id: bob.userId });
    const sendRes = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'v1' });
    await request(app).patch(`/api/channels/${channelId}/messages/${sendRes.body.id}`).set(authHeader(owner.accessToken)).send({ content: 'v2' });

    const res = await request(app).get(`/api/channels/${channelId}/messages/${sendRes.body.id}/edits`).set(authHeader(bob.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.content)).toEqual(['v1']);
  });

  test('a non-member gets 404', async () => {
    const owner = await signup('histowner3');
    const outsider = await signup('histoutsider3');
    const channelId = await createChannel(owner);
    const sendRes = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: 'hi' });

    const res = await request(app).get(`/api/channels/${channelId}/messages/${sendRes.body.id}/edits`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});
