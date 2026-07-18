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
    // displayName backfills to username at creation, same as every other
    // account-creation path (FEATURE_REQUEST.md's "display names as the
    // primary identity" entry).
    expect(res.body).toMatchObject({ username: 'newbare0', displayName: 'newbare0', email: 'newbare0@example.com' });
    expect(res.body.organizationId).toEqual(expect.any(String));
    expect(res.body.accessToken).toBeUndefined();

    const loginRes = await request(app).post('/api/auth/login').send({ username: 'newbare0', password: 'correct-horse-battery' });
    expect(loginRes.status).toBe(200);

    const memberships = await db('organization_members').where({ user_id: res.body.userId });
    expect(memberships).toHaveLength(1);

    const row = await db('audit_logs').where({ action_type: 'USER_ACCOUNT_CREATED' }).first();
    expect(row.payload).toMatchObject({ username: 'newbare0', email: 'newbare0@example.com' });
  });

  // FEATURE_REQUEST.md's "display names settable in the admin
  // account-creation worksheet" entry.
  test('an explicit displayName is stored and returned, distinct from username', async () => {
    const admin = await seedSystemAdmin('adminusersdn0');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({
        username: 'newbaredn0',
        email: 'newbaredn0@example.com',
        password: 'correct-horse-battery',
        displayName: 'Brand New Person',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'newbaredn0', displayName: 'Brand New Person' });

    const row = await db('users').where({ id: res.body.userId }).first('display_name');
    expect(row.display_name).toBe('Brand New Person');

    const auditRow = await db('audit_logs').where({ action_type: 'USER_ACCOUNT_CREATED' }).first();
    expect(auditRow.payload).toMatchObject({ displayName: 'Brand New Person' });
  });

  test('omitting displayName falls back to username, preserving prior behavior', async () => {
    const admin = await seedSystemAdmin('adminusersdn1');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'newbaredn1', email: 'newbaredn1@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'newbaredn1', displayName: 'newbaredn1' });
  });

  test('an empty displayName 400s', async () => {
    const admin = await seedSystemAdmin('adminusersdn2');

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({
        username: 'newbaredn2',
        email: 'newbaredn2@example.com',
        password: 'correct-horse-battery',
        displayName: '',
      });
    expect(res.status).toBe(400);
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
  test('a system admin sees the full roster, with pagination metadata', async () => {
    const admin = await seedSystemAdmin('adminlist0');
    const other = await signup('adminlistother0', { displayName: 'Admin List Other' });

    const res = await request(app).get('/api/admin/users').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(2);
    expect(res.body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: admin.userId,
          username: 'adminlist0',
          displayName: 'adminlist0',
          isSystemAdmin: true,
          status: 'ACTIVE',
        }),
        expect.objectContaining({
          userId: other.userId,
          username: 'adminlistother0',
          displayName: 'Admin List Other',
          isSystemAdmin: false,
          status: 'ACTIVE',
        }),
      ]),
    );
  });

  // FEATURE_REQUEST.md entry 4: offset-based pagination — a seeded set of
  // more than one page's worth of users requires more than one page to see
  // all of them, `total` reflects the real row count regardless of `limit`,
  // and an out-of-range `limit`/negative `offset` 400s the same way
  // parsePagination already does for message history.
  test('paginates with limit/offset, total matches real row count', async () => {
    const admin = await seedSystemAdmin('adminpage0');
    for (let i = 0; i < 4; i += 1) {
      await signup(`adminpageuser${i}`);
    }
    // 1 admin + 4 users = 5 total.

    const firstPage = await request(app)
      .get('/api/admin/users?limit=2&offset=0')
      .set(authHeader(admin.accessToken));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.users).toHaveLength(2);
    expect(firstPage.body.total).toBe(5);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.offset).toBe(0);

    const secondPage = await request(app)
      .get('/api/admin/users?limit=2&offset=2')
      .set(authHeader(admin.accessToken));
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.users).toHaveLength(2);

    const thirdPage = await request(app)
      .get('/api/admin/users?limit=2&offset=4')
      .set(authHeader(admin.accessToken));
    expect(thirdPage.status).toBe(200);
    expect(thirdPage.body.users).toHaveLength(1);

    const seenIds = new Set([
      ...firstPage.body.users.map((u) => u.userId),
      ...secondPage.body.users.map((u) => u.userId),
      ...thirdPage.body.users.map((u) => u.userId),
    ]);
    expect(seenIds.size).toBe(5);
  });

  test('an out-of-range limit 400s', async () => {
    const admin = await seedSystemAdmin('adminpage1');
    const res = await request(app).get('/api/admin/users?limit=1000').set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });

  test('a negative offset 400s', async () => {
    const admin = await seedSystemAdmin('adminpage2');
    const res = await request(app).get('/api/admin/users?offset=-1').set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });

  test('an offset beyond the total row count returns an empty array, not an error', async () => {
    const admin = await seedSystemAdmin('adminpage3');
    const res = await request(app).get('/api/admin/users?offset=9999').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.total).toBe(1);
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
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.workspaces).toEqual(
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

  // FEATURE_REQUEST.md entry 4: same offset-pagination contract as
  // GET /api/admin/users.
  test('paginates with limit/offset, total matches real row count', async () => {
    const admin = await seedSystemAdmin('wsadminpage0');
    const owner = await signup('wsadminpageowner0');
    for (let i = 0; i < 3; i += 1) {
      await createWorkspace(owner, `Workspace ${i}`);
    }
    // 3 workspaces total.

    const firstPage = await request(app)
      .get('/api/workspaces/admin/all?limit=2&offset=0')
      .set(authHeader(admin.accessToken));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.workspaces).toHaveLength(2);
    expect(firstPage.body.total).toBe(3);

    const secondPage = await request(app)
      .get('/api/workspaces/admin/all?limit=2&offset=2')
      .set(authHeader(admin.accessToken));
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.workspaces).toHaveLength(1);

    const seenIds = new Set([
      ...firstPage.body.workspaces.map((w) => w.id),
      ...secondPage.body.workspaces.map((w) => w.id),
    ]);
    expect(seenIds.size).toBe(3);
  });

  test('an out-of-range limit 400s', async () => {
    const admin = await seedSystemAdmin('wsadminpage1');
    const res = await request(app).get('/api/workspaces/admin/all?limit=0').set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });

  test('an offset beyond the total row count returns an empty array, not an error', async () => {
    const admin = await seedSystemAdmin('wsadminpage2');
    const res = await request(app).get('/api/workspaces/admin/all?offset=9999').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toEqual([]);
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

// System Admin panel: manage organizations and existing users. Granting/
// revoking is_system_admin has been offline-CLI-only since slice 1
// (scripts/grant-system-admin.mjs) — this is the first in-app, audited path.
describe('POST /api/admin/users/:userId/promote', () => {
  test('promotes a plain user to system admin', async () => {
    const admin = await seedSystemAdmin('promoteadmin0');
    const target = await signup('promotetarget0');

    const res = await request(app).post(`/api/admin/users/${target.userId}/promote`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: target.userId, isSystemAdmin: true });

    const row = await db('users').where({ id: target.userId }).first('is_system_admin');
    expect(row.is_system_admin).toBe(true);

    const auditRow = await db('audit_logs').where({ action_type: 'SYSTEM_ADMIN_STATUS_CHANGE' }).first();
    expect(auditRow.payload).toMatchObject({ targetUserId: target.userId, action: 'promote' });
  });

  test('is idempotent — promoting an already-admin user is a 200 no-op, not a duplicate audit row', async () => {
    const admin = await seedSystemAdmin('promoteadmin1');
    const target = await seedSystemAdmin('promotetarget1');

    const res = await request(app).post(`/api/admin/users/${target.userId}/promote`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'SYSTEM_ADMIN_STATUS_CHANGE' });
    expect(rows).toHaveLength(0);
  });

  test('a nonexistent target 404s', async () => {
    const admin = await seedSystemAdmin('promoteadmin2');
    const res = await request(app)
      .post('/api/admin/users/00000000-0000-0000-0000-000000000000/promote')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('promoteplain0');
    const target = await signup('promotetarget2');
    const res = await request(app).post(`/api/admin/users/${target.userId}/promote`).set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users/:userId/demote', () => {
  test('demotes a system admin back to a plain user', async () => {
    const admin = await seedSystemAdmin('demoteadmin0');
    const target = await seedSystemAdmin('demotetarget0');

    const res = await request(app).post(`/api/admin/users/${target.userId}/demote`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: target.userId, isSystemAdmin: false });

    const row = await db('users').where({ id: target.userId }).first('is_system_admin');
    expect(row.is_system_admin).toBe(false);

    const auditRow = await db('audit_logs').where({ action_type: 'SYSTEM_ADMIN_STATUS_CHANGE' }).first();
    expect(auditRow.payload).toMatchObject({ targetUserId: target.userId, action: 'demote' });
  });

  test('is idempotent — demoting an already-plain user is a 200 no-op, not a duplicate audit row', async () => {
    const admin = await seedSystemAdmin('demoteadmin1');
    const target = await signup('demotetarget1');

    const res = await request(app).post(`/api/admin/users/${target.userId}/demote`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);

    const rows = await db('audit_logs').where({ action_type: 'SYSTEM_ADMIN_STATUS_CHANGE' });
    expect(rows).toHaveLength(0);
  });

  // Mirrors /disable's own self-lockout guard: prevents the sole/last-acting
  // system admin from demoting themselves out of the ability to ever
  // promote anyone again without falling back to the offline CLI.
  test('a system admin cannot demote their own account', async () => {
    const admin = await seedSystemAdmin('demoteself0');
    const res = await request(app).post(`/api/admin/users/${admin.userId}/demote`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);

    const row = await db('users').where({ id: admin.userId }).first('is_system_admin');
    expect(row.is_system_admin).toBe(true);
  });

  test('a nonexistent target 404s', async () => {
    const admin = await seedSystemAdmin('demoteadmin2');
    const res = await request(app)
      .post('/api/admin/users/00000000-0000-0000-0000-000000000000/demote')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('demoteplain0');
    const target = await seedSystemAdmin('demotetarget2');
    const res = await request(app).post(`/api/admin/users/${target.userId}/demote`).set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});

// Global, workspace-independent password reset — closes a real gap
// POST /:workspaceId/members/:userId/reset-password (workspaces.js) can't: a
// bare account with no workspace tie could never have its password reset by
// anyone before this route existed.
describe('POST /api/admin/users/:userId/reset-password', () => {
  test("resets a bare account's password with no workspace tie, and revokes its sessions", async () => {
    const admin = await seedSystemAdmin('resetadmin0');
    const createRes = await request(app)
      .post('/api/admin/users')
      .set(authHeader(admin.accessToken))
      .send({ username: 'resettarget0', email: 'resettarget0@example.com', password: 'correct-horse-battery' });
    const targetUserId = createRes.body.userId;

    const loginRes = await request(app).post('/api/auth/login').send({ username: 'resettarget0', password: 'correct-horse-battery' });
    const cookieHeader = (loginRes.headers['set-cookie'] || []).find((c) => c.startsWith('refresh_token='));

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(204);

    const oldPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'resettarget0', password: 'correct-horse-battery' });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'resettarget0', password: 'a-brand-new-password' });
    expect(newPasswordLogin.status).toBe(200);

    const refreshAttempt = await request(app).post('/api/auth/refresh').set('Cookie', [cookieHeader.split(';')[0]]);
    expect(refreshAttempt.status).toBe(401);

    const row = await db('audit_logs').where({ action_type: 'ADMIN_PASSWORD_RESET' }).first();
    expect(row.payload).toMatchObject({ targetUserId, targetUsername: 'resettarget0' });
  });

  test("resetting the caller's own id 400s, pointing at the self-service flow", async () => {
    const admin = await seedSystemAdmin('resetadmin1');
    const res = await request(app)
      .post(`/api/admin/users/${admin.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/change-password/);
  });

  test('a password failing the policy 400s', async () => {
    const admin = await seedSystemAdmin('resetadmin2');
    const target = await signup('resettarget2');
    const res = await request(app)
      .post(`/api/admin/users/${target.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('a nonexistent target 404s', async () => {
    const admin = await seedSystemAdmin('resetadmin3');
    const res = await request(app)
      .post('/api/admin/users/00000000-0000-0000-0000-000000000000/reset-password')
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('resetplain0');
    const target = await signup('resettarget3');
    const res = await request(app)
      .post(`/api/admin/users/${target.userId}/reset-password`)
      .set(authHeader(user.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(403);
  });
});

// The one genuinely new read this panel needs: nothing before this answered
// "which orgs does user X belong to" from a user-centric view.
describe('GET /api/admin/users/:userId/organizations', () => {
  test("lists a user's organization memberships with role and archived status", async () => {
    const admin = await seedSystemAdmin('orglistadmin0');
    const target = await signup('orglisttarget0');
    const orgRes = await request(app).post('/api/organizations').set(authHeader(admin.accessToken)).send({ name: 'Second Org' });
    await request(app)
      .post(`/api/organizations/${orgRes.body.id}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orglisttarget0', role: 'ORG_ADMIN' });

    const res = await request(app).get(`/api/admin/users/${target.userId}/organizations`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: orgRes.body.id, role: 'ORG_ADMIN', archivedAt: null }),
      ]),
    );
  });

  test('a nonexistent target 404s', async () => {
    const admin = await seedSystemAdmin('orglistadmin1');
    const res = await request(app)
      .get('/api/admin/users/00000000-0000-0000-0000-000000000000/organizations')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a non-admin gets 403', async () => {
    const user = await signup('orglistplain0');
    const target = await signup('orglisttarget1');
    const res = await request(app).get(`/api/admin/users/${target.userId}/organizations`).set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });
});
