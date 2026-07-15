import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4:
// DELETE /:workspaceId/members/:userId (workspaces.js) — new this slice,
// cascading to channel_members.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

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

async function createChannel(owner, workspaceId, name) {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name, type: 'PUBLIC' });
  return res.body.id;
}

describe('DELETE /api/workspaces/:workspaceId/members/:userId', () => {
  test('an owner removes a plain member, cascading to their channel_members rows', async () => {
    const owner = await signup('removeowner0');
    const member = await signup('removetarget0');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removetarget0');

    const channelA = await createChannel(owner, workspaceId, 'general');
    const channelB = await createChannel(owner, workspaceId, 'random');
    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelA}/join`)
      .set(authHeader(member.accessToken));
    await db('channel_members').insert({ channel_id: channelB, user_id: member.userId });

    const before = await db('channel_members').where({ user_id: member.userId });
    expect(before).toHaveLength(2);

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);

    const membershipRow = await db('workspace_members').where({ workspace_id: workspaceId, user_id: member.userId }).first();
    expect(membershipRow).toBeUndefined();

    const after = await db('channel_members').where({ user_id: member.userId });
    expect(after).toHaveLength(0);

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_MEMBERSHIP_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ action: 'remove', targetUserId: member.userId, targetUsername: 'removetarget0' });
  });

  test('removing a non-member 404s', async () => {
    const owner = await signup('removeowner1');
    const outsider = await signup('removeoutsider1');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${outsider.userId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(404);
  });

  test('removing the OWNER 409s', async () => {
    const owner = await signup('removeowner2');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${owner.userId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(409);
  });

  test('a MANAGER can remove a plain MEMBER', async () => {
    const owner = await signup('removeowner3');
    const manager = await signup('removemanager3');
    const member = await signup('removetarget3');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removemanager3', 'MANAGER');
    await addMember(owner, workspaceId, 'removetarget3');

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(manager.accessToken));
    expect(res.status).toBe(204);
  });

  // MANAGER-tier split (SLICE_4_PLAN.md decision 8): a MANAGER holds only
  // WORKSPACE_MANAGE_MEMBERS, so removing another MANAGER — which requires
  // WORKSPACE_MANAGE_MANAGERS — is 403.
  test('a MANAGER cannot remove another MANAGER', async () => {
    const owner = await signup('removeowner4');
    const managerA = await signup('removemanagerA4');
    const managerB = await signup('removemanagerB4');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removemanagerA4', 'MANAGER');
    await addMember(owner, workspaceId, 'removemanagerB4', 'MANAGER');

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${managerB.userId}`)
      .set(authHeader(managerA.accessToken));
    expect(res.status).toBe(403);
  });

  test('the owner can remove a MANAGER', async () => {
    const owner = await signup('removeowner5');
    const manager = await signup('removemanager5');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removemanager5', 'MANAGER');

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${manager.userId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);
  });

  test('a plain member gets 403', async () => {
    const owner = await signup('removeowner6');
    const memberA = await signup('removememberA6');
    const memberB = await signup('removememberB6');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removememberA6');
    await addMember(owner, workspaceId, 'removememberB6');

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${memberB.userId}`)
      .set(authHeader(memberA.accessToken));
    expect(res.status).toBe(403);
  });

  test('an archived workspace 409s', async () => {
    const owner = await signup('removeowner7');
    const member = await signup('removetarget7');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'removetarget7');
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(409);
  });
});
