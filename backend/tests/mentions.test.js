import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { connectWs, waitForMessage, sendFrame } from './helpers/wsClient.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';
import { _resetForTests as resetPresence } from '../src/ws/presence.js';
import { _resetForTests as resetWsRateLimiter } from '../src/ws/rateLimiter.js';
import { extractMentionedUserIds } from '../src/services/mentionService.js';

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

describe('extractMentionedUserIds (unit)', () => {
  test('resolves a real channel-member username', async () => {
    const owner = await signup(app, 'mentowner0');
    const member = await signup(app, 'mentmember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const ids = await extractMentionedUserIds(db, {
      content: 'hey @mentmember0, look at this',
      channelId,
      excludeUserId: owner.userId,
    });
    expect(ids).toEqual([member.userId]);
  });

  test('ignores a nonexistent username', async () => {
    const owner = await signup(app, 'mentowner1');
    const { channelId } = await createChannelAsMember(owner);

    const ids = await extractMentionedUserIds(db, {
      content: '@nobodyhere are you around?',
      channelId,
      excludeUserId: owner.userId,
    });
    expect(ids).toEqual([]);
  });

  test('ignores a real user who is not a member of this channel', async () => {
    const owner = await signup(app, 'mentowner2');
    await signup(app, 'mentoutsider2');
    const { channelId } = await createChannelAsMember(owner);

    const ids = await extractMentionedUserIds(db, {
      content: '@mentoutsider2 join us?',
      channelId,
      excludeUserId: owner.userId,
    });
    expect(ids).toEqual([]);
  });

  test('dedupes repeated mentions of the same username', async () => {
    const owner = await signup(app, 'mentowner3');
    const member = await signup(app, 'mentmember3');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const ids = await extractMentionedUserIds(db, {
      content: '@mentmember3 @mentmember3 @mentmember3 are you there',
      channelId,
      excludeUserId: owner.userId,
    });
    expect(ids).toEqual([member.userId]);
  });

  test(
    'caps at 20 distinct usernames from a message containing more',
    async () => {
      const owner = await signup(app, 'mentowner4');
      const { workspaceId, channelId } = await createChannelAsMember(owner);

      const usernames = [];
      for (let i = 0; i < 25; i += 1) {
        const username = `mentflood${i}`;
        // eslint-disable-next-line no-await-in-loop
        const member = await signup(app, username);
        // eslint-disable-next-line no-await-in-loop
        await addMember(workspaceId, channelId, member);
        usernames.push(username);
      }

      const content = usernames.map((u) => `@${u}`).join(' ');
      const ids = await extractMentionedUserIds(db, { content, channelId, excludeUserId: owner.userId });
      expect(ids).toHaveLength(20);
    },
    20_000,
  );

  test("excludes the sender's own username", async () => {
    const owner = await signup(app, 'mentowner5');
    const { channelId } = await createChannelAsMember(owner);

    const ids = await extractMentionedUserIds(db, {
      content: '@mentowner5 talking to myself',
      channelId,
      excludeUserId: owner.userId,
    });
    expect(ids).toEqual([]);
  });
});

describe('mention delivery (integration)', () => {
  test('mentioning a channel member over REST delivers a mention frame, even without having joined the room', async () => {
    const owner = await signup(app, 'mentrest0');
    const member = await signup(app, 'mentrestmember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const memberWs = await openAndTrack();
    sendFrame(memberWs, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(memberWs, (e) => e.type === 'authenticated');
    // deliberately never sends 'join' — mentions must reach a user
    // regardless of which channel (if any) they currently have selected.

    const mentionPromise = waitForMessage(memberWs, (e) => e.type === 'mention');
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hey @mentrestmember0, check this out' });

    const mention = await mentionPromise;
    expect(mention.channelId).toBe(channelId);
    expect(mention.mentionedBy).toBe('mentrest0');
    expect(mention.message.content).toContain('@mentrestmember0');
  });

  test('mentioning a channel member over WS delivers a mention frame', async () => {
    const owner = await signup(app, 'mentws0');
    const member = await signup(app, 'mentwsmember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const ownerWs = await openAndTrack();
    sendFrame(ownerWs, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ownerWs, (e) => e.type === 'authenticated');
    sendFrame(ownerWs, { type: 'join', channelId });
    await waitForMessage(ownerWs, (e) => e.type === 'joined');

    const memberWs = await openAndTrack();
    sendFrame(memberWs, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(memberWs, (e) => e.type === 'authenticated');
    // again, deliberately not joined

    const mentionPromise = waitForMessage(memberWs, (e) => e.type === 'mention');
    sendFrame(ownerWs, { type: 'message', channelId, content: '@mentwsmember0 over the wire' });

    const mention = await mentionPromise;
    expect(mention.channelId).toBe(channelId);
    expect(mention.message.content).toBe('@mentwsmember0 over the wire');
  });

  test('a non-member mention produces no frame', async () => {
    const owner = await signup(app, 'mentnonmember0');
    const outsider = await signup(app, 'mentnonmemberoutsider0');
    const { channelId } = await createChannelAsMember(owner);

    const outsiderWs = await openAndTrack();
    sendFrame(outsiderWs, { type: 'authenticate', accessToken: outsider.accessToken });
    await waitForMessage(outsiderWs, (e) => e.type === 'authenticated');

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@mentnonmemberoutsider0 hello?' });

    await expect(waitForMessage(outsiderWs, (e) => e.type === 'mention', 300)).rejects.toThrow();
  });

  test('a user with two open connections gets the mention frame on both', async () => {
    const owner = await signup(app, 'mentmulti0');
    const member = await signup(app, 'mentmultimember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    const conn1 = await openAndTrack();
    sendFrame(conn1, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(conn1, (e) => e.type === 'authenticated');

    const conn2 = await openAndTrack();
    sendFrame(conn2, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(conn2, (e) => e.type === 'authenticated');

    const p1 = waitForMessage(conn1, (e) => e.type === 'mention');
    const p2 = waitForMessage(conn2, (e) => e.type === 'mention');
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@mentmultimember0 ping both' });

    await Promise.all([p1, p2]);
  });

  test('mentioning the sender themselves does not self-notify', async () => {
    const owner = await signup(app, 'mentself0');
    const { channelId } = await createChannelAsMember(owner);

    const ownerWs = await openAndTrack();
    sendFrame(ownerWs, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ownerWs, (e) => e.type === 'authenticated');

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@mentself0 note to self' });

    await expect(waitForMessage(ownerWs, (e) => e.type === 'mention', 300)).rejects.toThrow();
  });
});
