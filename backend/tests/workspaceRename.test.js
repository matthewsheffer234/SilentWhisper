import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"),
// Part 2: organizations already had PATCH /:orgId for renaming
// (organizations.js); workspaces never did. PATCH /:workspaceId
// (workspaces.js), gated on WORKSPACE_MANAGE_SETTINGS (same OWNER-only,
// plus system-admin-override, tier POST .../settings already uses).

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

describe('PATCH /api/workspaces/:workspaceId', () => {
  test('the owner can rename the workspace, and it is audited', async () => {
    const owner = await signup('wsrenameowner0');
    const workspaceId = await createWorkspace(owner, 'Old Name');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceId, name: 'New Name' });

    const ws = await db('workspaces').where({ id: workspaceId }).first('name');
    expect(ws.name).toBe('New Name');

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_RENAMED' }).first();
    expect(row.payload).toMatchObject({ fromName: 'Old Name', toName: 'New Name' });
  });

  test('is idempotent — setting the same name again does not write a duplicate audit row', async () => {
    const owner = await signup('wsrenameowner1');
    const workspaceId = await createWorkspace(owner, 'Same Name');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'Same Name' });
    expect(res.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'WORKSPACE_RENAMED' });
    expect(rows).toHaveLength(0);
  });

  test('a MANAGER (not the owner) gets 403', async () => {
    const owner = await signup('wsrenameowner2');
    const manager = await signup('wsrenamemanager2');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'wsrenamemanager2', 'MANAGER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(manager.accessToken))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(403);
  });

  test('a system admin (non-member) can rename via the structural-management override, and it is audited', async () => {
    const owner = await signup('wsrenameowner3');
    const admin = await seedSystemAdmin('wsrenameadmin3');
    const workspaceId = await createWorkspace(owner, 'Original');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'Admin Renamed' });
    expect(res.status).toBe(200);

    const ws = await db('workspaces').where({ id: workspaceId }).first('name');
    expect(ws.name).toBe('Admin Renamed');
  });

  test('an empty name 400s', async () => {
    const owner = await signup('wsrenameowner4');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app).patch(`/api/workspaces/${workspaceId}`).set(authHeader(owner.accessToken)).send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('an archived workspace 409s', async () => {
    const owner = await signup('wsrenameowner5');
    const workspaceId = await createWorkspace(owner);
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(409);
  });

  test('a non-member outsider gets 404, not 403', async () => {
    const owner = await signup('wsrenameowner6');
    const outsider = await signup('wsrenameoutsider6');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}`)
      .set(authHeader(outsider.accessToken))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(404);
  });
});
