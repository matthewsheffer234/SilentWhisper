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

async function createWorkspace(owner, name = 'W') {
  const res = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name });
  return res.body.id;
}

async function addMember(owner, workspaceId, username, role) {
  await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(owner.accessToken))
    .send(role ? { username, role } : { username });
}

async function createChannel(owner, workspaceId, name = 'general', type = 'PUBLIC') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name, type });
  return res.body.id;
}

describe('POST /api/workspaces/:workspaceId/archive', () => {
  test('the owner can archive, and it is idempotent', async () => {
    const owner = await signup('archowner0');
    const workspaceId = await createWorkspace(owner);

    const first = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.archivedAt).toBeTruthy();

    const second = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));
    expect(second.status).toBe(200);

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_ARCHIVE_STATUS_CHANGE' }).count('* as count').first();
    expect(Number(row.count)).toBe(1);
  });

  // managers_can_archive (FEATURE_REQUEST.md entry 1, slice 4): defaults to
  // false, so a MANAGER cannot archive until the owner explicitly delegates
  // it via POST /:workspaceId/settings — a real behavior tightening versus
  // pre-slice-4 (a MANAGER could always archive before).
  test('a manager (who is not the owner) cannot archive by default', async () => {
    const owner = await signup('archowner1');
    const manager = await signup('archadmin1');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'archadmin1', 'MANAGER');

    const res = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(manager.accessToken));
    expect(res.status).toBe(403);
  });

  test('once the owner enables managers_can_archive, a manager can archive', async () => {
    const owner = await signup('archowner1b');
    const manager = await signup('archadmin1b');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'archadmin1b', 'MANAGER');

    const settingsRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/settings`)
      .set(authHeader(owner.accessToken))
      .send({ managersCanArchive: true });
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.managersCanArchive).toBe(true);

    const res = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(manager.accessToken));
    expect(res.status).toBe(200);
  });

  test('only the owner can toggle managers_can_archive — a manager gets 403', async () => {
    const owner = await signup('archowner1c');
    const manager = await signup('archadmin1c');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'archadmin1c', 'MANAGER');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/settings`)
      .set(authHeader(manager.accessToken))
      .send({ managersCanArchive: true });
    expect(res.status).toBe(403);
  });

  test('a plain member cannot archive (403)', async () => {
    const owner = await signup('archowner2');
    const member = await signup('archmember2');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'archmember2');

    const res = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('a non-member outsider gets 404, not 403 (existence-hiding)', async () => {
    const owner = await signup('archowner3');
    const outsider = await signup('archoutsider3');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:workspaceId/unarchive', () => {
  test('an admin can unarchive', async () => {
    const owner = await signup('unarchowner0');
    const workspaceId = await createWorkspace(owner);
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app).post(`/api/workspaces/${workspaceId}/unarchive`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  // Superseded by the enterprise-authz slice 1 role model (FEATURE_REQUEST.md
  // entry 1): a workspace owner can no longer be demoted at all (migration
  // 0012 guarantees exactly one OWNER, and PATCH .../members/:userId rejects
  // changing the owner's own role — see adminUserManagement.test.js's
  // "cannot change the owner's role directly" coverage), so the old scenario
  // this test exercised ("an owner who isn't separately an ADMIN member")
  // can no longer be constructed. Archive/unarchive share one
  // WORKSPACE_ARCHIVE gate (OWNER unconditionally, MANAGER only once
  // managers_can_archive is enabled — slice 4), tested below.
  test('a manager (not the owner) cannot unarchive by default, but can once managers_can_archive is enabled', async () => {
    const owner = await signup('unarchowner1');
    const manager = await signup('unarchadmin1');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'unarchadmin1', 'MANAGER');
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const deniedRes = await request(app).post(`/api/workspaces/${workspaceId}/unarchive`).set(authHeader(manager.accessToken));
    expect(deniedRes.status).toBe(403);

    await request(app)
      .post(`/api/workspaces/${workspaceId}/settings`)
      .set(authHeader(owner.accessToken))
      .send({ managersCanArchive: true });

    const res = await request(app).post(`/api/workspaces/${workspaceId}/unarchive`).set(authHeader(manager.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  test('both directions are audited with the right action discriminator', async () => {
    const owner = await signup('unarchowner2');
    const workspaceId = await createWorkspace(owner);
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));
    await request(app).post(`/api/workspaces/${workspaceId}/unarchive`).set(authHeader(owner.accessToken));

    const rows = await db('audit_logs').where({ action_type: 'WORKSPACE_ARCHIVE_STATUS_CHANGE' }).orderBy('id', 'asc');
    expect(rows.map((r) => r.payload.action)).toEqual(['archive', 'unarchive']);
  });
});

describe('every gated write path 409s against an archived workspace', () => {
  async function setupArchived() {
    const owner = await signup(`arch${Date.now()}${Math.floor(Math.random() * 1000)}`);
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));
    return { owner, workspaceId, channelId };
  }

  test('inviting a member 409s', async () => {
    const { owner, workspaceId } = await setupArchived();
    await signup(`archtarget${Date.now()}`);
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'nonexistent-anyway' });
    expect(res.status).toBe(409);
  });

  test('creating a channel 409s', async () => {
    const { owner, workspaceId } = await setupArchived();
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'another', type: 'PUBLIC' });
    expect(res.status).toBe(409);
  });

  test('joining a channel 409s', async () => {
    const { workspaceId, channelId } = await setupArchived();
    const member = await signup(`archjoiner${Date.now()}`);
    // Membership predates the archive, added via a raw insert since the
    // invite endpoint is itself gated (tested above) — this test is about
    // the join endpoint specifically.
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
      .set(authHeader(member.accessToken));
    expect(res.status).toBe(409);
  });

  test('adding an existing workspace member to a channel 409s', async () => {
    const { owner, workspaceId, channelId } = await setupArchived();
    const member = await signup(`archaddee${Date.now()}`);
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ userId: member.userId });
    expect(res.status).toBe(409);
  });

  test('changing a member\'s role 409s', async () => {
    const { owner, workspaceId } = await setupArchived();
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${owner.userId}`)
      .set(authHeader(owner.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(409);
  });

  test('sending a message over REST 409s', async () => {
    const { owner, channelId } = await setupArchived();
    const res = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'hello into the void' });
    expect(res.status).toBe(409);
  });

  test('sending a message over the WebSocket is rejected the same way, not a bypass', async () => {
    const { owner, channelId } = await setupArchived();

    const ws = await openAndTrack();
    sendFrame(ws, { type: 'authenticate', accessToken: owner.accessToken });
    await waitForMessage(ws, (e) => e.type === 'authenticated');
    sendFrame(ws, { type: 'join', channelId });
    await waitForMessage(ws, (e) => e.type === 'joined');

    sendFrame(ws, { type: 'message', channelId, content: 'ws message into the void' });
    const errorMsg = await waitForMessage(ws, (e) => e.type === 'error');
    expect(errorMsg.error).toMatch(/archived/i);
  });
});

describe('read paths remain available for an archived workspace', () => {
  test('GET /workspaces reports archivedAt, and channel/history reads still work', async () => {
    const owner = await signup(`archread${Date.now()}`);
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'before archiving' });
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const listRes = await request(app).get('/api/workspaces').set(authHeader(owner.accessToken));
    const ws = listRes.body.find((w) => w.id === workspaceId);
    expect(ws.archivedAt).toBeTruthy();

    const channelsRes = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(owner.accessToken));
    expect(channelsRes.status).toBe(200);

    const historyRes = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(owner.accessToken));
    expect(historyRes.status).toBe(200);
    expect(historyRes.body[0].content).toBe('before archiving');
  });
});
