import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { connectWs, waitForMessage, sendFrame } from './helpers/wsClient.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';
import { _resetForTests as resetPresence } from '../src/ws/presence.js';
import { _resetForTests as resetWsRateLimiter } from '../src/ws/rateLimiter.js';

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

async function createChannelAsMember(owner) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  return { workspaceId: wsRes.body.id, channelId: chRes.body.id };
}

async function addMember(workspaceId, channelId, user) {
  await db('workspace_members').insert({ workspace_id: workspaceId, user_id: user.userId, system_role: 'MEMBER' });
  await request(app)
    .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
    .set(authHeader(user.accessToken));
}

describe('mention notifications', () => {
  test('REST mentions create a persisted unread notification with list and summary data', async () => {
    const owner = await signup('notifrest0');
    const member = await signup('notifmember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hey @notifmember0 check this' })
      .expect(201);

    const res = await request(app)
      .get('/api/notifications/mentions')
      .set(authHeader(member.accessToken))
      .expect(200);

    expect(res.body.summary.unreadCount).toBe(1);
    expect(res.body.summary.byWorkspace).toEqual([{ workspaceId, unreadCount: 1 }]);
    expect(res.body.summary.byChannel).toEqual([{ channelId, unreadCount: 1 }]);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      channelId,
      workspaceId,
      senderUsername: 'notifrest0',
      // FEATURE_REQUEST.md's "display names as the primary identity" entry.
      senderDisplayName: 'notifrest0',
      channelName: 'general',
      preview: 'hey @notifmember0 check this',
      readAt: null,
    });
  });

  test('WebSocket mentions include the persisted notification id in the live frame', async () => {
    const owner = await signup('notifws0');
    const member = await signup('notifwsmember0');
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

    const mentionPromise = waitForMessage(memberWs, (e) => e.type === 'mention');
    sendFrame(ownerWs, { type: 'message', channelId, content: '@notifwsmember0 from ws' });

    const mention = await mentionPromise;
    expect(mention.workspaceId).toBe(workspaceId);
    expect(mention.notificationId).toEqual(expect.any(String));

    const rows = await db('mention_notifications').where({ recipient_user_id: member.userId });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mention.notificationId);
  });

  test('repeated mentions dedupe and self/non-member mentions do not create notifications', async () => {
    const owner = await signup('notifdedupe0');
    const member = await signup('notifdedupemember0');
    const outsider = await signup('notifdedupeoutsider0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@notifdedupemember0 @notifdedupemember0 @notifdedupe0 @notifdedupeoutsider0' })
      .expect(201);

    expect(await db('mention_notifications').where({ recipient_user_id: member.userId })).toHaveLength(1);
    expect(await db('mention_notifications').where({ recipient_user_id: owner.userId })).toHaveLength(0);
    expect(await db('mention_notifications').where({ recipient_user_id: outsider.userId })).toHaveLength(0);
  });

  test('mark read and read all are scoped to the authenticated recipient', async () => {
    const owner = await signup('notifread0');
    const member = await signup('notifreadmember0');
    const other = await signup('notifreadother0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);
    await addMember(workspaceId, channelId, other);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@notifreadmember0 first @notifreadother0' })
      .expect(201);
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@notifreadmember0 second' })
      .expect(201);

    const list = await request(app).get('/api/notifications/mentions').set(authHeader(member.accessToken)).expect(200);
    const [first] = list.body.notifications;

    await request(app)
      .patch(`/api/notifications/mentions/${first.id}/read`)
      .set(authHeader(other.accessToken))
      .expect(404);

    await request(app)
      .patch(`/api/notifications/mentions/${first.id}/read`)
      .set(authHeader(member.accessToken))
      .expect(200);

    let summary = await request(app).get('/api/notifications/summary').set(authHeader(member.accessToken)).expect(200);
    expect(summary.body.unreadCount).toBe(1);

    await request(app).post('/api/notifications/mentions/read-all').set(authHeader(member.accessToken)).expect(200);
    summary = await request(app).get('/api/notifications/summary').set(authHeader(member.accessToken)).expect(200);
    expect(summary.body.unreadCount).toBe(0);

    const otherSummary = await request(app).get('/api/notifications/summary').set(authHeader(other.accessToken)).expect(200);
    expect(otherSummary.body.unreadCount).toBe(1);
  });

  test('removed channel members cannot list stale private-channel notification previews', async () => {
    const owner = await signup('notifstale0');
    const member = await signup('notifstalemember0');
    const { workspaceId, channelId } = await createChannelAsMember(owner);
    await addMember(workspaceId, channelId, member);

    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: '@notifstalemember0 private detail' })
      .expect(201);

    await db('channel_members').where({ channel_id: channelId, user_id: member.userId }).del();

    const res = await request(app).get('/api/notifications/mentions').set(authHeader(member.accessToken)).expect(200);
    expect(res.body.summary.unreadCount).toBe(0);
    expect(res.body.notifications).toEqual([]);
  });
});
