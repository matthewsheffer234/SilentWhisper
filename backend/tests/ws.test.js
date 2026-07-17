import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { connectWs, waitForMessage, waitForClose, sendFrame } from './helpers/wsClient.js';
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

async function createChannelAsMember(owner, { type = 'PUBLIC' } = {}) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type });
  return { workspaceId: wsRes.body.id, channelId: chRes.body.id };
}

describe('authenticate handshake', () => {
  test('rejects any frame before authentication and closes the connection', async () => {
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'join', channelId: 'whatever' });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/not authenticated/i);
    await waitForClose(ws);
  });

  test('rejects an invalid access token and closes the connection', async () => {
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: 'not-a-real-token' });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/invalid or expired/i);
    await waitForClose(ws);
  });

  test('accepts a valid access token', async () => {
    const user = await signup('wsuser1');
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: user.accessToken });
    const authedMsg = await waitForMessage(ws, (e) => e.type === 'authenticated');
    expect(authedMsg.userId).toBe(user.userId);
    expect(authedMsg.reauth).toBe(false);
  });

  test('supports re-authenticating the same identity on an already-open connection', async () => {
    const user = await signup('wsuser2');
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: user.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    sendFrame(ws, { type: 'authenticate', accessToken: user.accessToken });
    const reauthMsg = await waitForMessage(ws, (e) => e.type === 'authenticated');
    expect(reauthMsg.reauth).toBe(true);
  });

  test('rejects re-authenticating as a different user on the same connection', async () => {
    const userA = await signup('wsuser3');
    const userB = await signup('wsuser4');
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: userA.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    sendFrame(ws, { type: 'authenticate', accessToken: userB.accessToken });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/identity/i);
    await waitForClose(ws);
  });

  test('enforces the max concurrent connections per user', async () => {
    const user = await signup('wsuser5');
    for (let i = 0; i < config.ws.maxConnectionsPerUser; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ws = await openAndTrack();
      sendFrame(ws, { type: 'authenticate', accessToken: user.accessToken });
      // eslint-disable-next-line no-await-in-loop
      await waitForMessage(ws, (e) => e.type === 'authenticated');
    }

    const oneTooMany = await openAndTrack();
    sendFrame(oneTooMany, { type: 'authenticate', accessToken: user.accessToken });
    const errorMsg = await waitForMessage(oneTooMany, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/too many concurrent connections/i);
    await waitForClose(oneTooMany);
  });
});

describe('account disable — immediate WebSocket eviction (FEATURE_REQUEST.md entry 1)', () => {
  test('disabling a connected user force-closes their open socket immediately', async () => {
    const admin = await seedSystemAdmin('wsdisableadmin0');
    const target = await signup('wsdisabletarget0');
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: target.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    // Attach listeners before triggering the disable — the eviction happens
    // synchronously inside the admin route handler, so waiting on the REST
    // response first would risk missing the close.
    const errorPromise = waitForMessage(ws, (e) => e.type === 'error');
    const closePromise = waitForClose(ws);
    const res = await request(app)
      .post(`/api/admin/users/${target.userId}/disable`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);

    const errorMsg = await errorPromise;
    expect(errorMsg.error).toMatch(/disabled/i);
    await closePromise;
  });

  test('a disabled user cannot authenticate a new connection with a still-unexpired access token', async () => {
    const admin = await seedSystemAdmin('wsdisableadmin1');
    const target = await signup('wsdisabletarget1');
    await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(admin.accessToken));

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: target.accessToken });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/invalid or expired/i);
    await waitForClose(ws);
  });

  test('a disabled user cannot renew an already-authenticated connection via a re-authenticate frame', async () => {
    const target = await signup('wsdisabletarget2');
    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: target.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    // Flips status directly rather than through the admin route, so this
    // isolates handleAuthenticate's reauth-branch status check from the
    // separate immediate-eviction path the first test above already covers.
    await db('users').where({ id: target.userId }).update({ status: 'DISABLED' });

    sendFrame(ws, { type: 'authenticate', accessToken: target.accessToken });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/invalid or expired/i);
    await waitForClose(ws);
  });
});

describe('WebSocket payload limit (FEATURE_REQUEST.md entry 1)', () => {
  test('a frame larger than the configured maxPayload closes the connection before it is parsed', async () => {
    const ws = await openAndTrack();
    // A single oversized field is enough — the `ws` receiver enforces
    // maxPayload at the frame level, before any application code (including
    // JSON.parse in the 'message' handler) ever sees the payload.
    const oversizedToken = 'x'.repeat(config.ws.maxPayloadBytes + 1024);
    sendFrame(ws, { type: 'authenticate', accessToken: oversizedToken });
    const closeResult = await waitForClose(ws);
    expect(closeResult.code).toBe(1009);
  });
});

describe('room join authorization', () => {
  test('joining a channel you are a member of succeeds', async () => {
    const owner = await signup('wsowner1');
    const { channelId } = await createChannelAsMember(owner);

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    sendFrame(ws, { type: 'join', channelId });
    const joined = await waitForMessage(ws, (e) => e.type === 'joined');
    expect(joined.channelId).toBe(channelId);
  });

  test('joining a channel you are not a member of is denied without revealing whether it exists', async () => {
    const owner = await signup('wsowner2');
    const outsider = await signup('wsoutsider1');
    const { channelId } = await createChannelAsMember(owner, { type: 'PRIVATE' });

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: outsider.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');

    sendFrame(ws, { type: 'join', channelId });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toBe('Channel not found');

    // A join attempt against a channel ID that never existed at all gets the
    // identical message — the two cases must be indistinguishable.
    sendFrame(ws, { type: 'join', channelId: '00000000-0000-0000-0000-000000000000' });
    const errorMsg2 = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg2.error).toBe(errorMsg.error);
  });

  test('re-validates membership on every reconnect rather than trusting a prior session', async () => {
    const owner = await signup('wsowner3');
    const member = await signup('wsmember1');
    const { workspaceId, channelId } = await createChannelAsMember(owner, { type: 'PRIVATE' });

    // First connection: member is not yet added, join is denied.
    const firstConn = await openAndTrack();
    sendFrame(firstConn, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(firstConn, (e) => e.type === 'authenticated');
    sendFrame(firstConn, { type: 'join', channelId });
    await waitForMessage(firstConn, (e) => e.type === 'error');
    firstConn.close();

    // Add them to the workspace (no self-service "join workspace" endpoint
    // exists yet — Phase 2 only auto-adds the creator), then to the channel.
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });
    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: member.username });

    // A brand-new connection (simulating reconnect) re-checks membership
    // fresh and now succeeds — nothing about the first connection's denial
    // was cached against this user/channel pair.
    const secondConn = await openAndTrack();
    sendFrame(secondConn, { type: 'authenticate', accessToken: member.accessToken });
    await waitForMessage(secondConn, (e) => e.type === 'authenticated');
    sendFrame(secondConn, { type: 'join', channelId });
    const joined = await waitForMessage(secondConn, (e) => e.type === 'joined');
    expect(joined.channelId).toBe(channelId);
  });
});

describe('message delivery', () => {
  test('a message sent by one joined client is broadcast to another joined client, but not to a non-joined one', async () => {
    const owner = await signup('wssender1');
    const { workspaceId, channelId } = await createChannelAsMember(owner, { type: 'PUBLIC' });
    const receiver = await signup('wsreceiver1');
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: receiver.userId, system_role: 'MEMBER' });
    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
      .set(authHeader(receiver.accessToken));
    const outsider = await signup('wsoutsider2');

    const senderWs = await openAndTrack();
    sendFrame(senderWs, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(senderWs, (e) => e.type === 'authenticated');
    sendFrame(senderWs, { type: 'join', channelId });
    await waitForMessage(senderWs, (e) => e.type === 'joined');

    const receiverWs = await openAndTrack();
    sendFrame(receiverWs, { type: 'authenticate', accessToken: receiver.accessToken });
    await waitForMessage(receiverWs, (e) => e.type === 'authenticated');
    sendFrame(receiverWs, { type: 'join', channelId });
    await waitForMessage(receiverWs, (e) => e.type === 'joined');

    const outsiderWs = await openAndTrack();
    sendFrame(outsiderWs, { type: 'authenticate', accessToken: outsider.accessToken });
    await waitForMessage(outsiderWs, (e) => e.type === 'authenticated');
    // outsider deliberately does not join channelId

    sendFrame(senderWs, { type: 'message', channelId, content: 'hello over the wire' });

    const delivered = await waitForMessage(receiverWs, (e) => e.type === 'message_created');
    expect(delivered.message.content).toBe('hello over the wire');
    expect(delivered.message.userId).toBe(owner.userId);

    // The outsider should never receive it — give the broadcast a moment to
    // (not) arrive, then confirm nothing showed up.
    await expect(waitForMessage(outsiderWs, (e) => e.type === 'message_created', 300)).rejects.toThrow();
  });

  test('a REST-sent message is also broadcast to WS-joined clients', async () => {
    const owner = await signup('wssender2');
    const { channelId } = await createChannelAsMember(owner, { type: 'PUBLIC' });

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    // Attach the listener *before* triggering the broadcast — awaiting the
    // REST round trip first would leave a window where the broadcast could
    // arrive and be dropped before anything was listening for it.
    const deliveredPromise = waitForMessage(ws, (e) => e.type === 'message_created');
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'sent via REST' });

    const delivered = await deliveredPromise;
    expect(delivered.message.content).toBe('sent via REST');
  });

  test('a message sent over the socket echoes back the clientNonce for optimistic-send reconciliation', async () => {
    const owner = await signup('wssender4');
    const { channelId } = await createChannelAsMember(owner, { type: 'PUBLIC' });

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    sendFrame(ws, { type: 'message', channelId, content: 'optimistic test', clientNonce: 'nonce-123' });
    const delivered = await waitForMessage(ws, (e) => e.type === 'message_created');
    expect(delivered.clientNonce).toBe('nonce-123');
    expect(delivered.message.content).toBe('optimistic test');
  });

  test('sending to a channel you have not joined over the socket is rejected', async () => {
    const owner = await signup('wssender3');
    const { channelId } = await createChannelAsMember(owner, { type: 'PUBLIC' });

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    // deliberately skip 'join'

    sendFrame(ws, { type: 'message', channelId, content: 'should not go through' });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/join the channel/i);
  });
});

describe('presence', () => {
  test('another user authenticating broadcasts an online presence update to already-connected clients', async () => {
    const userA = await signup('wspresence1');
    const userB = await signup('wspresence2');

    const wsA = await openAndTrack();
    sendFrame(wsA, { type: 'authenticate', accessToken: userA.accessToken });
    const authedA = await waitForMessage(wsA, (e) => e.type === 'authenticated');
    // recordHeartbeat runs before the snapshot is taken, so A's own entry is
    // already present — nobody *else* is online yet at this point, though.
    expect(authedA.presence).toEqual({ [userA.userId]: 'online' });

    // Attach wsA's listener before sending wsB's authenticate frame — the
    // presence broadcast to wsA happens as part of handling that frame, so
    // waiting for wsB's own ack first would risk missing it in the gap.
    const presenceUpdatePromise = waitForMessage(
      wsA,
      (e) => e.type === 'presence_update' && e.userId === userB.userId,
    );
    const wsB = await openAndTrack();
    sendFrame(wsB, { type: 'authenticate', accessToken: userB.accessToken });
    await waitForMessage(wsB, (e) => e.type === 'authenticated');

    const presenceUpdate = await presenceUpdatePromise;
    expect(presenceUpdate.status).toBe('online');
  });

  test('disconnecting broadcasts an offline presence update', async () => {
    const userA = await signup('wspresence3');
    const userB = await signup('wspresence4');

    const wsA = await openAndTrack();
    sendFrame(wsA, { type: 'authenticate', accessToken: userA.accessToken });
    await waitForMessage(wsA, (e) => e.type === 'authenticated');

    const onlineUpdatePromise = waitForMessage(wsA, (e) => e.type === 'presence_update' && e.status === 'online');
    const wsB = await openAndTrack();
    sendFrame(wsB, { type: 'authenticate', accessToken: userB.accessToken });
    await waitForMessage(wsB, (e) => e.type === 'authenticated');
    await onlineUpdatePromise;

    const offlineUpdatePromise = waitForMessage(
      wsA,
      (e) => e.type === 'presence_update' && e.userId === userB.userId,
    );
    wsB.close();
    const offlineUpdate = await offlineUpdatePromise;
    expect(offlineUpdate.status).toBe('offline');
  });
});

describe('message rate limiting', () => {
  test('exceeding the per-user message window rate is rejected', async () => {
    const owner = await signup('wsratelimit1');
    const { channelId } = await createChannelAsMember(owner);

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    for (let i = 0; i < config.ws.maxMessagesPerWindow; i += 1) {
      sendFrame(ws, { type: 'message', channelId, content: `msg ${i}` });
      // eslint-disable-next-line no-await-in-loop
      await waitForMessage(ws, (e) => e.type === 'message_created');
    }

    sendFrame(ws, { type: 'message', channelId, content: 'one too many' });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/rate limit/i);
  });
});
