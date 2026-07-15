import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4:
// POST /:workspaceId/visibility (workspaces.js) — its own dedicated
// endpoint, separate from POST /:workspaceId/settings (managers_can_archive).

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

describe('POST /api/workspaces/:workspaceId/visibility', () => {
  test('the owner can change visibility, and it is audited', async () => {
    const owner = await signup('visowner0');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(owner.accessToken))
      .send({ visibility: 'DISCOVERABLE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspaceId, visibility: 'DISCOVERABLE' });

    const ws = await db('workspaces').where({ id: workspaceId }).first('visibility');
    expect(ws.visibility).toBe('DISCOVERABLE');

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_VISIBILITY_CHANGED' }).first();
    expect(row.payload).toMatchObject({ fromVisibility: 'PRIVATE', toVisibility: 'DISCOVERABLE' });
  });

  test('is idempotent — setting the same visibility again does not write a duplicate audit row', async () => {
    const owner = await signup('visowner1');
    const workspaceId = await createWorkspace(owner);

    await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(owner.accessToken))
      .send({ visibility: 'PRIVATE' });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(owner.accessToken))
      .send({ visibility: 'PRIVATE' });
    expect(res.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'WORKSPACE_VISIBILITY_CHANGED' });
    expect(rows).toHaveLength(0);
  });

  test('a MANAGER (not the owner) gets 403', async () => {
    const owner = await signup('visowner2');
    const manager = await signup('vismanager2');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'vismanager2', 'MANAGER');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(manager.accessToken))
      .send({ visibility: 'DISCOVERABLE' });
    expect(res.status).toBe(403);
  });

  test('an invalid visibility value 400s', async () => {
    const owner = await signup('visowner3');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(owner.accessToken))
      .send({ visibility: 'PUBLIC' });
    expect(res.status).toBe(400);
  });

  test('an archived workspace 409s', async () => {
    const owner = await signup('visowner4');
    const workspaceId = await createWorkspace(owner);
    await request(app).post(`/api/workspaces/${workspaceId}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(owner.accessToken))
      .send({ visibility: 'DISCOVERABLE' });
    expect(res.status).toBe(409);
  });

  test('a non-member outsider gets 404, not 403', async () => {
    const owner = await signup('visowner5');
    const outsider = await signup('visoutsider5');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/visibility`)
      .set(authHeader(outsider.accessToken))
      .send({ visibility: 'DISCOVERABLE' });
    expect(res.status).toBe(404);
  });
});
