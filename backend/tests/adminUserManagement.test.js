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
    const admin = await signup('wsadmin0');
    const member = await signup('wsmember0');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'wsmember0');

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    // displayName rides alongside username (FEATURE_REQUEST.md's "display
    // names as the primary identity" entry) — backfilled to match username
    // for both of these test-seeded accounts.
    expect(res.body).toEqual(
      expect.arrayContaining([
        { userId: admin.userId, username: 'wsadmin0', displayName: 'wsadmin0', role: 'OWNER' },
        { userId: member.userId, username: 'wsmember0', displayName: 'wsmember0', role: 'MEMBER' },
      ]),
    );
  });

  test('a plain member gets 403', async () => {
    const admin = await signup('wsadmin1');
    const member = await signup('wsmember1');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'wsmember1');

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('a non-member gets 404, not 403 (existence-hiding)', async () => {
    const admin = await signup('wsadmin2');
    const outsider = await signup('wsoutsider2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app).get(`/api/workspaces/${workspaceId}/members`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/workspaces/:workspaceId/members/:userId', () => {
  test('an owner can promote a member to MANAGER', async () => {
    const admin = await signup('roleadmin0');
    const member = await signup('rolemember0');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember0');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('MANAGER');

    const row = await db('audit_logs').where({ action_type: 'WORKSPACE_MEMBERSHIP_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ action: 'role_change', targetUserId: member.userId, fromRole: 'MEMBER', toRole: 'MANAGER' });
  });

  test('demoting a manager succeeds', async () => {
    const admin = await signup('roleadmin1');
    const manager = await signup('rolemember1');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember1', 'MANAGER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${manager.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(200);
  });

  // Supersedes the old "sole admin" last-admin-count guard: OWNER is now
  // structurally unique per workspace (migration 0012) and never directly
  // reassignable through this endpoint at all — the check is a flat
  // equality, not a count, and applies even if other MANAGERs exist.
  test("changing the workspace owner's own role directly is rejected with 409", async () => {
    const admin = await signup('roleadmin2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(409);
  });

  test('a plain member gets 403', async () => {
    const admin = await signup('roleadmin3');
    const member = await signup('rolemember3');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember3');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(member.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(403);
  });

  test("an admin of workspace A gets 404 against a user in workspace B they don't administer", async () => {
    const adminA = await signup('roleadminA');
    const adminB = await signup('roleadminB');
    const memberB = await signup('rolememberB');
    const workspaceA = await createWorkspace(adminA, 'A');
    const workspaceB = await createWorkspace(adminB, 'B');
    await addMember(adminB, workspaceB, 'rolememberB');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceA}/members/${memberB.userId}`)
      .set(authHeader(adminA.accessToken))
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(404);
  });

  test('an invalid role value 400s', async () => {
    const admin = await signup('roleadmin4');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'SUPERUSER' });
    expect(res.status).toBe(400);
  });

  test('role: OWNER is rejected with 400 — not an assignable role value', async () => {
    const admin = await signup('roleadmin5');
    const member = await signup('rolemember5');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'rolemember5');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'OWNER' });
    expect(res.status).toBe(400);
  });

  // New (FEATURE_REQUEST.md entry 1, slice 4): the WORKSPACE_MANAGE_MEMBERS/
  // WORKSPACE_MANAGE_MANAGERS split. A MANAGER holds only
  // WORKSPACE_MANAGE_MEMBERS, so promoting someone to MANAGER — which
  // requires WORKSPACE_MANAGE_MANAGERS — is now 403 for a MANAGER, a real
  // tightening versus pre-slice-4 behavior (a MANAGER could do this before).
  test('a manager (holding only WORKSPACE_MANAGE_MEMBERS) gets 403 promoting a member to MANAGER', async () => {
    const owner = await signup('mgrsplitowner0');
    const manager = await signup('mgrsplitmanager0');
    const member = await signup('mgrsplitmember0');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'mgrsplitmanager0', 'MANAGER');
    await addMember(owner, workspaceId, 'mgrsplitmember0');

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(manager.accessToken))
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(403);
  });

  // The mirror image: promoting someone to MANAGER, or demoting an existing
  // MANAGER, still requires WORKSPACE_MANAGE_MEMBERS as a floor too — a
  // MANAGER promoting a plain MEMBER's own role change that doesn't touch
  // the MANAGER tier still works fine, proving the split is genuinely
  // MANAGER-tier-scoped, not a blanket narrowing of everything MANAGER used
  // to be able to do.
  test('a manager can still demote a MEMBER-tier role change unaffected by the MANAGER split', async () => {
    const owner = await signup('mgrsplitowner1');
    const manager = await signup('mgrsplitmanager1');
    const member = await signup('mgrsplitmember1');
    const workspaceId = await createWorkspace(owner);
    await addMember(owner, workspaceId, 'mgrsplitmanager1', 'MANAGER');
    await addMember(owner, workspaceId, 'mgrsplitmember1');

    // A no-op MEMBER -> MEMBER role change: touches neither the caller's
    // nor the target's MANAGER tier, so WORKSPACE_MANAGE_MEMBERS alone
    // suffices.
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(authHeader(manager.accessToken))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/workspaces/:workspaceId/members/:userId/reset-password', () => {
  test("an admin resets another member's password: old fails, new works, and the target is logged out everywhere", async () => {
    const admin = await signup('resetadmin0');
    const member = await signup('resetmember0');
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
    const admin = await signup('resetadmin1');
    const outsider = await signup('resetoutsider1');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${outsider.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(404);
  });

  test("resetting the caller's own id 400s, pointing at the self-service flow", async () => {
    const admin = await signup('resetadmin2');
    const workspaceId = await createWorkspace(admin);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${admin.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/change-password/);
  });

  test('a password failing the policy 400s', async () => {
    const admin = await signup('resetadmin3');
    const member = await signup('resetmember3');
    const workspaceId = await createWorkspace(admin);
    await addMember(admin, workspaceId, 'resetmember3');

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/${member.userId}/reset-password`)
      .set(authHeader(admin.accessToken))
      .send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('a plain member gets 403', async () => {
    const admin = await signup('resetadmin4');
    const memberA = await signup('resetmemberA4');
    const memberB = await signup('resetmemberB4');
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
