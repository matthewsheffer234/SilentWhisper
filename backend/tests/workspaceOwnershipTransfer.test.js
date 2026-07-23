import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

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

  // FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"),
  // Part 1: a system admin calling this route always goes through
  // requireWorkspacePermission's override branch (membershipService.js),
  // never through their own workspace_members row, even if they happen to
  // have one — so "demote the caller" was always the wrong thing to demote
  // whenever the caller is a system admin. Proves the fix directly: exactly
  // one OWNER row survives, it's the real previous owner who gets demoted
  // (not the admin, who was never a member), and the audit trail attributes
  // the transfer to the real previous owner, not the acting admin.
  test('a system admin (non-member) transferring ownership demotes the real owner, not themselves — exactly one OWNER remains', async () => {
    const owner = await signup('transferowner7');
    const target = await signup('transfertarget7');
    const admin = await seedSystemAdmin('transferadmin7');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'transfertarget7');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'transfertarget7' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceId, ownerId: target.userId });

    const ws = await db('workspaces').where({ id: workspaceId }).first('owner_id');
    expect(ws.owner_id).toBe(target.userId);

    const memberRows = await db('workspace_members').where({ workspace_id: workspaceId }).select('user_id', 'system_role');
    const ownerRows = memberRows.filter((r) => r.system_role === 'OWNER');
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0].user_id).toBe(target.userId);

    const oldOwnerRow = memberRows.find((r) => r.user_id === owner.userId);
    expect(oldOwnerRow.system_role).toBe('MANAGER');

    // The admin never held a workspace_members row and still doesn't.
    const adminRow = memberRows.find((r) => r.user_id === admin.userId);
    expect(adminRow).toBeUndefined();

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_OWNERSHIP_TRANSFERRED' }).first();
    expect(row.payload).toMatchObject({ fromUserId: owner.userId, toUserId: target.userId, toUsername: 'transfertarget7' });
  });

  test('transferring to the account that is already the owner 400s', async () => {
    const owner = await signup('transferowner8');
    const workspaceId = await createWorkspace(owner);
    const admin = await seedSystemAdmin('transferadmin8');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/transfer-ownership`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'transferowner8' });
    expect(res.status).toBe(400);

    const ws = await db('workspaces').where({ id: workspaceId }).first('owner_id');
    expect(ws.owner_id).toBe(owner.userId);
  });
});
