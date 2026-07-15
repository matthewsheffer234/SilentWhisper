import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4:
// POST /:workspaceId/transfer-ownership (workspaces.js) — takes a username,
// not a userId (SLICE_4_PLAN.md decision 7).

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

describe('POST /api/workspaces/:workspaceId/transfer-ownership', () => {
  test('the owner can transfer to an existing member; old owner becomes MANAGER', async () => {
    const owner = await signup('transferowner0');
    const member = await signup('transfertarget0');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'transfertarget0');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'transfertarget0' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceId, ownerId: member.userId });

    const ws = await db('workspaces').where({ id: workspaceId }).first('owner_id');
    expect(ws.owner_id).toBe(member.userId);

    const oldOwnerRow = await db('workspace_members').where({ workspace_id: workspaceId, user_id: owner.userId }).first('system_role');
    expect(oldOwnerRow.system_role).toBe('MANAGER');
    const newOwnerRow = await db('workspace_members').where({ workspace_id: workspaceId, user_id: member.userId }).first('system_role');
    expect(newOwnerRow.system_role).toBe('OWNER');

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_OWNERSHIP_TRANSFERRED' }).first();
    expect(row.payload).toMatchObject({ fromUserId: owner.userId, toUserId: member.userId, toUsername: 'transfertarget0' });
  });

  test('a non-owner (MANAGER) gets 403', async () => {
    const owner = await signup('transferowner1');
    const manager = await signup('transfermanager1');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'transfermanager1', 'MANAGER');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(manager.accessToken))
      .send({ username: 'transferowner1' });
    expect(res.status).toBe(403);
  });

  test('target must already be a member of this workspace — 400 otherwise', async () => {
    const owner = await signup('transferowner2');
    const outsider = await signup('transferoutsider2');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'transferoutsider2' });
    expect(res.status).toBe(400);

    const ws = await db('workspaces').where({ id: workspaceId }).first('owner_id');
    expect(ws.owner_id).toBe(owner.userId);
  });

  test('a nonexistent username 400s', async () => {
    const owner = await signup('transferowner3');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'no-such-user-anywhere' });
    expect(res.status).toBe(400);
  });

  test('self-transfer 400s', async () => {
    const owner = await signup('transferowner4');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'transferowner4' });
    expect(res.status).toBe(400);
  });

  test('an archived workspace 409s', async () => {
    const owner = await signup('transferowner5');
    const member = await signup('transfertarget5');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'transfertarget5');
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'transfertarget5' });
    expect(res.status).toBe(409);
  });

  test('a non-member outsider gets 404, not 403 (existence-hiding)', async () => {
    const owner = await signup('transferowner6');
    const outsider = await signup('transferoutsider6');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(outsider.accessToken))
      .send({ username: 'transferowner6' });
    expect(res.status).toBe(404);
  });
});
