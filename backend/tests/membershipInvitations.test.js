import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { createOrg } from './helpers/fixtures.js';
import { connectWs, waitForMessage, sendFrame } from './helpers/wsClient.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';
import { _resetForTests as resetPresence } from '../src/ws/presence.js';
import { _resetForTests as resetWsRateLimiter } from '../src/ws/rateLimiter.js';

// FEATURE_REQUEST.md "Live notification system + in-app invitation
// notification & acceptance workflow": membership_invitations addresses an
// *existing* account (userId, not email/token) — distinct from
// invitations.test.js's token-based flow for people with no account yet.

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

async function createWorkspace(owner, name = 'Invite Workspace') {
  const res = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name });
  return res.body;
}

describe('POST /api/organizations/:orgId/membership-invitations', () => {
  test('an ORG_ADMIN can invite an existing user; a plain ORG_MEMBER cannot', async () => {
    const admin = await seedSystemAdmin('orgmiadmin0');
    const org = await createOrg(admin.accessToken);
    const target = await signup('orgmitarget0');

    const res = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(admin.accessToken))
      .send({ userId: target.userId, role: 'ORG_MEMBER' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ invitedUserId: target.userId, invitedUsername: 'orgmitarget0', role: 'ORG_MEMBER', status: 'PENDING' });

    const row = await db('membership_invitations').where({ id: res.body.id }).first();
    expect(row).toMatchObject({ scope_type: 'ORGANIZATION', organization_id: org.id, invited_user_id: target.userId, status: 'PENDING' });

    const auditRow = await db('audit_logs').where({ action_type: 'ORGANIZATION_MEMBERSHIP_CHANGE' }).orderBy('id', 'desc').first();
    expect(auditRow.payload).toMatchObject({ action: 'invite', invitedUserId: target.userId, role: 'ORG_MEMBER' });

    const member = await signup('orgmimember0');
    await request(app).post(`/api/organizations/${org.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'orgmimember0' });
    const target2 = await signup('orgmitarget1');
    const forbidden = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(member.accessToken))
      .send({ userId: target2.userId });
    expect(forbidden.status).toBe(403);
  });

  test('inviting an existing member 409s; a duplicate pending invite 409s', async () => {
    const admin = await seedSystemAdmin('orgmidupe0');
    const org = await createOrg(admin.accessToken);
    const existingMember = await signup('orgmidupemember0');
    await request(app).post(`/api/organizations/${org.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'orgmidupemember0' });

    const alreadyMember = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(admin.accessToken))
      .send({ userId: existingMember.userId });
    expect(alreadyMember.status).toBe(409);

    const target = await signup('orgmidupetarget0');
    const first = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(admin.accessToken))
      .send({ userId: target.userId });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(admin.accessToken))
      .send({ userId: target.userId });
    expect(duplicate.status).toBe(409);
  });

  test('a non-member caller gets 404, not 403', async () => {
    const admin = await seedSystemAdmin('orgminonmember0');
    const org = await createOrg(admin.accessToken);
    const outsider = await signup('orgminonmemberoutsider0');
    const target = await signup('orgminonmembertarget0');

    const res = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(outsider.accessToken))
      .send({ userId: target.userId });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:workspaceId/membership-invitations', () => {
  test('a workspace OWNER can invite as MEMBER or MANAGER; a plain MANAGER cannot invite as MANAGER', async () => {
    const owner = await signup('wsmiowner0');
    const ws = await createWorkspace(owner);
    const target = await signup('wsmitarget0');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: target.userId, role: 'MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ invitedUserId: target.userId, role: 'MANAGER', status: 'PENDING' });

    const manager = await signup('wsmimanager0');
    await request(app)
      .post(`/api/workspaces/${ws.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'wsmimanager0', role: 'MANAGER' });
    const target2 = await signup('wsmitarget1');

    const managerInvitingManager = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(manager.accessToken))
      .send({ userId: target2.userId, role: 'MANAGER' });
    expect(managerInvitingManager.status).toBe(403);

    const managerInvitingMember = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(manager.accessToken))
      .send({ userId: target2.userId, role: 'MEMBER' });
    expect(managerInvitingMember.status).toBe(201);
  });

  test('inviting an existing member 409s', async () => {
    const owner = await signup('wsmidupe0');
    const ws = await createWorkspace(owner);
    const existingMember = await signup('wsmidupemember0');
    await request(app).post(`/api/workspaces/${ws.id}/members`).set(authHeader(owner.accessToken)).send({ username: 'wsmidupemember0' });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: existingMember.userId });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/membership-invitations/:id/accept and /decline', () => {
  test('only the invited user can accept their own row; accept creates the offered-role membership', async () => {
    const owner = await signup('wsmiaccept0');
    const ws = await createWorkspace(owner);
    const target = await signup('wsmiaccepttarget0');
    const other = await signup('wsmiacceptother0');

    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: target.userId, role: 'MANAGER' });

    const wrongUser = await request(app)
      .post(`/api/membership-invitations/${createRes.body.id}/accept`)
      .set(authHeader(other.accessToken));
    expect(wrongUser.status).toBe(404);
    expect(await db('workspace_members').where({ workspace_id: ws.id, user_id: other.userId })).toHaveLength(0);

    const res = await request(app)
      .post(`/api/membership-invitations/${createRes.body.id}/accept`)
      .set(authHeader(target.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: createRes.body.id, status: 'ACCEPTED' });

    const membership = await db('workspace_members').where({ workspace_id: ws.id, user_id: target.userId }).first();
    expect(membership.system_role).toBe('MANAGER');

    const row = await db('membership_invitations').where({ id: createRes.body.id }).first();
    expect(row.status).toBe('ACCEPTED');
    expect(row.resolved_at).not.toBeNull();

    // Accepting again (already resolved) 404s, same generic response.
    const again = await request(app)
      .post(`/api/membership-invitations/${createRes.body.id}/accept`)
      .set(authHeader(target.accessToken));
    expect(again.status).toBe(404);
  });

  test('decline creates no membership and resolves the row as DECLINED', async () => {
    const admin = await seedSystemAdmin('orgmidecline0');
    const org = await createOrg(admin.accessToken);
    const target = await signup('orgmidecline0target');

    const createRes = await request(app)
      .post(`/api/organizations/${org.id}/membership-invitations`)
      .set(authHeader(admin.accessToken))
      .send({ userId: target.userId });

    const other = await signup('orgmidecline0other');
    const wrongUser = await request(app)
      .post(`/api/membership-invitations/${createRes.body.id}/decline`)
      .set(authHeader(other.accessToken));
    expect(wrongUser.status).toBe(404);

    const res = await request(app)
      .post(`/api/membership-invitations/${createRes.body.id}/decline`)
      .set(authHeader(target.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: createRes.body.id, status: 'DECLINED' });

    expect(await db('organization_members').where({ organization_id: org.id, user_id: target.userId })).toHaveLength(0);
    const row = await db('membership_invitations').where({ id: createRes.body.id }).first();
    expect(row.status).toBe('DECLINED');
  });
});

describe('GET /api/membership-invitations', () => {
  test('lists only the caller\'s own pending invitations', async () => {
    const owner = await signup('wsmilist0');
    const ws = await createWorkspace(owner, 'List Workspace');
    const target = await signup('wsmilisttarget0');
    const other = await signup('wsmilistother0');

    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: target.userId, role: 'MEMBER' });

    const otherList = await request(app).get('/api/membership-invitations').set(authHeader(other.accessToken));
    expect(otherList.status).toBe(200);
    expect(otherList.body.invitations).toEqual([]);
    expect(otherList.body.total).toBe(0);

    const targetList = await request(app).get('/api/membership-invitations').set(authHeader(target.accessToken));
    expect(targetList.status).toBe(200);
    expect(targetList.body.invitations).toHaveLength(1);
    expect(targetList.body.total).toBe(1);
    expect(targetList.body.invitations[0]).toMatchObject({
      id: createRes.body.id,
      scopeType: 'WORKSPACE',
      scopeName: 'List Workspace',
      invitedRole: 'MEMBER',
      invitedByUsername: 'wsmilist0',
    });

    // Resolving it removes it from the pending list.
    await request(app).post(`/api/membership-invitations/${createRes.body.id}/decline`).set(authHeader(target.accessToken));
    const afterDecline = await request(app).get('/api/membership-invitations').set(authHeader(target.accessToken));
    expect(afterDecline.body.invitations).toEqual([]);
  });

  test('rejects malformed pagination params and returns a correctly bounded page', async () => {
    const owner = await signup('wsmipage0');
    const ws = await createWorkspace(owner, 'Page Workspace');
    const target = await signup('wsmipagetarget0');
    await signup('wsmipagetarget0b');

    const bad = await request(app)
      .get('/api/membership-invitations')
      .query({ limit: 0 })
      .set(authHeader(target.accessToken));
    expect(bad.status).toBe(400);

    await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: target.userId, role: 'MEMBER' });

    const page = await request(app)
      .get('/api/membership-invitations')
      .query({ limit: 1, offset: 0 })
      .set(authHeader(target.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.invitations).toHaveLength(1);
    expect(page.body.limit).toBe(1);
    expect(page.body.offset).toBe(0);
    expect(page.body.total).toBe(1);
  });
});

describe('live delivery and notification summary', () => {
  test('WS delivery reaches only the invited user\'s own connections, and the alert is reflected in a subsequent summary', async () => {
    const owner = await signup('wsminotify0');
    const ws = await createWorkspace(owner);
    const target = await signup('wsminotifytarget0');
    const bystander = await signup('wsminotifybystander0');

    const targetWs = await openAndTrack();
    sendFrame(targetWs, { type: 'authenticate', accessToken: target.accessToken });
    await waitForMessage(targetWs, (e) => e.type === 'authenticated');

    const bystanderWs = await openAndTrack();
    sendFrame(bystanderWs, { type: 'authenticate', accessToken: bystander.accessToken });
    await waitForMessage(bystanderWs, (e) => e.type === 'authenticated');

    const invitationPromise = waitForMessage(targetWs, (e) => e.type === 'membership_invitation');
    let bystanderGotIt = false;
    const bystanderListener = (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === 'membership_invitation') bystanderGotIt = true;
    };
    bystanderWs.on('message', bystanderListener);

    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/membership-invitations`)
      .set(authHeader(owner.accessToken))
      .send({ userId: target.userId, role: 'MEMBER' });

    const frame = await invitationPromise;
    expect(frame.scopeName).toBe(ws.name);
    expect(frame.invitedRole).toBe('MEMBER');
    expect(frame.notificationId).toEqual(expect.any(String));
    bystanderWs.off('message', bystanderListener);
    expect(bystanderGotIt).toBe(false);

    const summary = await request(app).get('/api/notifications/summary').set(authHeader(target.accessToken)).expect(200);
    expect(summary.body.membershipInvitationUnreadCount).toBe(1);
    expect(summary.body.unreadCount).toBe(1);

    // Accepting resolves the underlying alert too (best-effort mark-read).
    await request(app).post(`/api/membership-invitations/${createRes.body.id}/accept`).set(authHeader(target.accessToken)).expect(200);
    const afterAccept = await request(app).get('/api/notifications/summary').set(authHeader(target.accessToken)).expect(200);
    expect(afterAccept.body.membershipInvitationUnreadCount).toBe(0);
  });
});
