import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

function extractCookie(res, name) {
  const setCookie = res.headers['set-cookie'] || [];
  const match = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
  return match ? match.split('=')[1] : null;
}

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
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(owner.accessToken))
    .send(role ? { username, role } : { username });
  return res;
}

describe('GET /api/workspaces/:workspaceId/members', () => {
  test('an admin sees the full roster with roles', async () => {
    const admin = await signup(app, 'wsadmin0');
    const member = await signup(app, 'wsmember0');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'wsmember0');

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { userId: admin.userId, username: 'wsadmin0', role: 'ADMIN' },
        { userId: member.userId, username: 'wsmember0', role: 'MEMBER' },
      ]),
    );
  });

  test('a plain member gets 403', async () => {
    const admin = await signup(app, 'wsadmin1');
    const member = await signup(app, 'wsmember1');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'wsmember1');

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('a non-member gets 404, not 403 (existence-hiding)', async () => {
    const admin = await signup(app, 'wsadmin2');
    const outsider = await signup(app, 'wsoutsider2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/workspaces/:workspaceId/members/:userId', () => {
  test('an admin can promote a member to ADMIN', async () => {
    const admin = await signup(app, 'roleadmin0');
    const member = await signup(app, 'rolemember0');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember0');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ADMIN');

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_MEMBERSHIP_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ action: 'role_change', targetUserId: member.userId, fromRole: 'MEMBER', toRole: 'ADMIN' });
  });

  test('demoting one of two admins succeeds', async () => {
    const admin = await signup(app, 'roleadmin1');
    const secondAdmin = await signup(app, 'rolemember1');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember1', 'ADMIN');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${secondAdmin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(200);
  });

  test('demoting the workspace\'s sole admin is rejected with 409', async () => {
    const admin = await signup(app, 'roleadmin2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(409);
  });

  test('a plain member gets 403', async () => {
    const admin = await signup(app, 'roleadmin3');
    const member = await signup(app, 'rolemember3');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember3');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(member.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(403);
  });

  test("an admin of workspace A gets 404 against a user in workspace B they don't administer", async () => {
    const adminA = await signup(app, 'roleadminA');
    const adminB = await signup(app, 'roleadminB');
    const memberB = await signup(app, 'rolememberB');
    const workspaceA = await createWorkspace(adminA, 'A');
    const workspaceB = await createWorkspace(adminB, 'B');
    await addMember(adminB, workspaceB, 'rolememberB');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceA}/members/${memberB.userId}`)
      .set(authHeader(adminA.accessToken))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(404);
  });

  test('an invalid role value 400s', async () => {
    const admin = await signup(app, 'roleadmin4');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'SUPERUSER' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/workspaces/:workspaceId/users', () => {
  test('an admin creates a new account that lands as a MEMBER by default and can log in', async () => {
    const admin = await signup(app, 'createadmin0');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'newperson0', email: 'newperson0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'newperson0', email: 'newperson0@example.com', role: 'MEMBER' });
    expect(res.body.accessToken).toBeUndefined();

    const loginRes = await request(app).post('/api/auth/login').send({ username: 'newperson0', password: 'correct-horse-battery' });
    expect(loginRes.status).toBe(200);

    const membership = await db('workspace_members').where({ workspace_id: workspaceId, user_id: res.body.userId }).first();
    expect(membership.system_role).toBe('MEMBER');

    const row = await db('audit_logs').where({ action_type: 'USER_ACCOUNT_CREATED' }).first();
    expect(row.payload).toMatchObject({ username: 'newperson0', workspaceId, role: 'MEMBER' });
  });

  test('an admin can create a new account directly as ADMIN', async () => {
    const admin = await signup(app, 'createadmin1');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'newperson1', email: 'newperson1@example.com', password: 'correct-horse-battery', role: 'ADMIN' });
    expect(res.status).toBe(201);

    const membership = await db('workspace_members').where({ workspace_id: workspaceId, user_id: res.body.userId }).first();
    expect(membership.system_role).toBe('ADMIN');
  });

  test('a duplicate username or email 409s with the same generic message signup uses', async () => {
    const admin = await signup(app, 'createadmin2');
    const workspaceId = await createWorkspace(admin);

    const dupUsername = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'createadmin2', email: 'unique@example.com', password: 'correct-horse-battery' });
    expect(dupUsername.status).toBe(409);

    const dupEmail = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'someoneelse', email: 'createadmin2@example.com', password: 'correct-horse-battery' });
    expect(dupEmail.status).toBe(409);
    expect(dupUsername.body.error).toBe(dupEmail.body.error);
  });

  test('a password failing the policy 400s', async () => {
    const admin = await signup(app, 'createadmin3');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'newperson3', email: 'newperson3@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  test('a plain member gets 403', async () => {
    const admin = await signup(app, 'createadmin4');
    const member = await signup(app, 'creatememb4');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'creatememb4');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/users`)
      .set(authHeader(member.accessToken))
      .send({ username: 'newperson4', email: 'newperson4@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/workspaces/:workspaceId/members/:userId/reset-password', () => {
  test("an admin resets another member's password: old fails, new works, and the target is logged out everywhere", async () => {
    const admin = await signup(app, 'resetadmin0');
    const member = await signup(app, 'resetmember0');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'resetmember0');

    const memberLoginRes = await request(app).post('/api/auth/login').send({ username: 'resetmember0', password: 'correct-horse-battery' });
    const memberRefreshCookie = extractCookie(memberLoginRes, 'refresh_token');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${member.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(204);

    const oldPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'resetmember0', password: 'correct-horse-battery' });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'resetmember0', password: 'a-brand-new-password' });
    expect(newPasswordLogin.status).toBe(200);

    const refreshAttempt = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${memberRefreshCookie}`]);
    expect(refreshAttempt.status).toBe(401);

    const row = await db('audit_logs').where({ action_type: 'ADMIN_PASSWORD_RESET' }).first();
    expect(row.payload).toMatchObject({ targetUserId: member.userId, targetUsername: 'resetmember0', workspaceId });
  });

  test('resetting a non-member of the workspace 404s', async () => {
    const admin = await signup(app, 'resetadmin1');
    const outsider = await signup(app, 'resetoutsider1');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${outsider.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(404);
  });

  test("resetting the caller's own id 400s, pointing at the self-service flow", async () => {
    const admin = await signup(app, 'resetadmin2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${admin.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/change-password/);
  });

  test('a password failing the policy 400s', async () => {
    const admin = await signup(app, 'resetadmin3');
    const member = await signup(app, 'resetmember3');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'resetmember3');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${member.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('a plain member gets 403', async () => {
    const admin = await signup(app, 'resetadmin4');
    const memberA = await signup(app, 'resetmemberA4');
    const memberB = await signup(app, 'resetmemberB4');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'resetmemberA4');
    await addMember(admin, workspaceId, 'resetmemberB4');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${memberB.userId}/reset-password`)
      .set(authHeader(memberA.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(403);
  });
});
