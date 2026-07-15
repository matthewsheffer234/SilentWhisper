import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4:
// system-admin-only account lifecycle (backend/src/routes/admin.js),
// retiring POST /:workspaceId/users (workspaces.js) — a plain workspace
// OWNER/MANAGER can no longer directly provision accounts at all.

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

describe('POST /api/admin/users', () => {
  test('a system admin can create a bare account with no workspace tie', async () => {
    const admin = await seedSystemAdmin('adminusers0');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'newbare0', email: 'newbare0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'newbare0', email: 'newbare0@example.com' });
    expect(res.body.organizationId).toEqual(expect.any(String));
    expect(res.body.accessToken).toBeUndefined();

    const loginRes = await request(app).post('/api/auth/login').send({ username: 'newbare0', password: 'correct-horse-battery' });
    expect(loginRes.status).toBe(200);

    const memberships = await db('organization_members').where({ user_id: res.body.userId });
    expect(memberships).toHaveLength(1);

    const row = await db('audit_logs').where({ action_type: 'USER_ACCOUNT_CREATED' }).first();
    expect(row.payload).toMatchObject({ username: 'newbare0', email: 'newbare0@example.com' });
  });

  test('omitting organizationId auto-enrolls into the earliest-created organization', async () => {
    const admin = await seedSystemAdmin('adminusers1');
    const earliestOrg = await db('organizations').orderBy('created_at', 'asc').first('id');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'newbare1', email: 'newbare1@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.body.organizationId).toBe(earliestOrg.id);
  });

  test('an explicit organizationId attaches the account to that org, with no membership check on the admin', async () => {
    const admin = await seedSystemAdmin('adminusers2');
    const orgRes = await request(app).post('/api/organizations').set(authHeader(admin.accessToken)).send({ name: 'Some Other Org' });
    // Demote the admin out of ORG_ADMIN of the new org to prove no
    // membership relationship is required for a system admin to attach a
    // bare account to it.
    await db('organization_members').where({ organization_id: orgRes.body.id, user_id: admin.userId }).del();

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'newbare2', email: 'newbare2@example.com', password: 'correct-horse-battery', organizationId: orgRes.body.id });
    expect(res.status).toBe(201);
    expect(res.body.organizationId).toBe(orgRes.body.id);
  });

  test('a nonexistent organizationId 400s (a body-param problem, not a path 404)', async () => {
    const admin = await seedSystemAdmin('adminusers3');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({
        username: 'newbare3',
        email: 'newbare3@example.com',
        password: 'correct-horse-battery',
        organizationId: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(400);
  });

  test('a duplicate username or email 409s with the same generic message signup used to', async () => {
    const admin = await seedSystemAdmin('adminusers4');
    await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'dupuser4', email: 'dupuser4@example.com', password: 'correct-horse-battery' });

    const dupUsername = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'dupuser4', email: 'unique4@example.com', password: 'correct-horse-battery' });
    const dupEmail = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'someoneelse4', email: 'dupuser4@example.com', password: 'correct-horse-battery' });
    expect(dupUsername.status).toBe(409);
    expect(dupEmail.status).toBe(409);
    expect(dupUsername.body.error).toBe(dupEmail.body.error);
  });

  test('a password failing the policy 400s', async () => {
    const admin = await seedSystemAdmin('adminusers5');
    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'newbare5', email: 'newbare5@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  test('a non-admin, non-system-admin user gets 403', async () => {
    const user = await signup('plainuser0');
    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(user.accessToken))
      .send({ username: 'newbare6', email: 'newbare6@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(403);
  });

  // Proves decision 2's tightening (SLICE_4_PLAN.md): a plain workspace
  // OWNER — who could provision accounts via the now-deleted
  // POST /:workspaceId/users — has no capability here at all.
  test('a plain workspace OWNER (not a system admin) gets 403', async () => {
    const owner = await signup('plainowner0');
    await createWorkspace(owner);

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(owner.accessToken))
      .send({ username: 'newbare7', email: 'newbare7@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/users', () => {
  test('a system admin sees the full roster', async () => {
    const admin = await seedSystemAdmin('adminlist0');
    const other = await signup('adminlistother0');

    const res = await request(app).get('/api/admin/users').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: admin.userId, username: 'adminlist0', isSystemAdmin: true, status: 'ACTIVE' }),
        expect.objectContaining({ userId: other.userId, username: 'adminlistother0', isSystemAdmin: false, status: 'ACTIVE' }),
      ]),
    );
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('adminlistplain0');
    const res = await request(app).get('/api/admin/users').set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users/:userId/disable', () => {
  test("disabling revokes the target's refresh tokens and blocks their next login, generically", async () => {
    const admin = await seedSystemAdmin('disableadmin0');
    const target = await signup('disabletarget0');
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'disabletarget0', password: 'correct-horse-battery' });
    const cookieHeader = (loginRes.headers['set-cookie'] || []).find((c) => c.startsWith('refresh_token='));

    const res = await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: target.userId, status: 'DISABLED' });

    const loginAttempt = await request(app).post('/api/auth/login').send({ username: 'disabletarget0', password: 'correct-horse-battery' });
    expect(loginAttempt.status).toBe(401);
    expect(loginAttempt.body.error).toBe('Invalid username or password');

    const refreshAttempt = await request(app).post('/api/auth/refresh').set('Cookie', [cookieHeader.split(';')[0]]);
    expect(refreshAttempt.status).toBe(401);

    const row = await db('audit_logs').where({ action_type: 'USER_STATUS_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ targetUserId: target.userId, action: 'disable' });
  });

  test('is idempotent — disabling an already-disabled user is a 200 no-op, not a duplicate audit row', async () => {
    const admin = await seedSystemAdmin('disableadmin1');
    const target = await signup('disabletarget1');

    await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(admin.accessToken));
    const second = await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(admin.accessToken));
    expect(second.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'USER_STATUS_CHANGE' });
    expect(rows).toHaveLength(1);
  });

  test('a sole system admin cannot disable their own account', async () => {
    const admin = await seedSystemAdmin('disableself0');
    const res = await request(app).post(`/api/admin/users/${admin.userId}/disable`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });

  test('a nonexistent target 404s', async () => {
    const admin = await seedSystemAdmin('disableadmin2');
    const res = await request(app)
      .post('/api/admin/users/00000000-0000-0000-0000-000000000000/disable')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('disableplain0');
    const target = await signup('disabletarget2');
    const res = await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users/:userId/enable', () => {
  test('re-enables a disabled user, who can log in again', async () => {
    const admin = await seedSystemAdmin('enableadmin0');
    const target = await signup('enabletarget0');
    await request(app).post(`/api/admin/users/${target.userId}/disable`).set(authHeader(admin.accessToken));

    const res = await request(app).post(`/api/admin/users/${target.userId}/enable`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: target.userId, status: 'ACTIVE' });

    const loginRes = await request(app).post('/api/auth/login').send({ username: 'enabletarget0', password: 'correct-horse-battery' });
    expect(loginRes.status).toBe(200);

    const row = await db('audit_logs').where({ action_type: 'USER_STATUS_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ targetUserId: target.userId, action: 'enable' });
  });

  test('is idempotent — enabling an already-active user is a 200 no-op', async () => {
    const admin = await seedSystemAdmin('enableadmin1');
    const target = await signup('enabletarget1');

    const res = await request(app).post(`/api/admin/users/${target.userId}/enable`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'USER_STATUS_CHANGE' });
    expect(rows).toHaveLength(0);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('enableplain0');
    const target = await signup('enabletarget2');
    const res = await request(app).post(`/api/admin/users/${target.userId}/enable`).set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});

// GET /api/workspaces/admin/all (workspaces.js) — direct isSystemAdminUser
// gate, same reasoning as this file's other routes. Tested here rather than
// in a workspace-scoped file since it's a system-wide oversight surface,
// thematically alongside GET /api/admin/users.
describe('GET /api/workspaces/admin/all', () => {
  test('a system admin sees every workspace regardless of membership, across every organization', async () => {
    const admin = await seedSystemAdmin('wsadminall0');
    const owner = await signup('wsadminallowner0');
    const workspaceId = await createWorkspace(owner, 'Not Admin\'s Workspace');

    const res = await request(app).get('/api/workspaces/admin/all').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workspaceId,
          ownerUsername: 'wsadminallowner0',
          visibility: 'PRIVATE',
          archivedAt: null,
        }),
      ]),
    );
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('wsadminallplain0');
    const res = await request(app).get('/api/workspaces/admin/all').set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('a plain workspace OWNER (not a system admin) gets 403', async () => {
    const owner = await signup('wsadminallowner1');
    await createWorkspace(owner);
    const res = await request(app).get('/api/workspaces/admin/all').set(authHeader(owner.accessToken));
    expect(res.status).toBe(403);
  });
});
