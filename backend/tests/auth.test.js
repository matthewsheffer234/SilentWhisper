import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { revokeAllRefreshTokensForUser } from '../src/auth/refreshTokens.js';

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

// POST /api/auth/signup no longer exists (FEATURE_REQUEST.md entry 1, slice
// 4: self-service signup is closed) — every account now originates from
// scripts/create-first-admin.mjs, POST /api/admin/users, or invitation
// redemption. See adminUsers.test.js for account-creation coverage.
describe('POST /api/auth/signup (removed, slice 4)', () => {
  // Not a 404: unmatched /api/* paths fall through past authRouter (no
  // route left there) to the next bare-/api-mounted router with a route
  // table of its own, whose unconditional requireAuth middleware fires
  // before any sub-route match is even attempted — pre-existing routing
  // structure, not new to this slice. Either way, the route is gone: no
  // account is created, and an unauthenticated caller is blocked either way.
  test('the route no longer exists — falls through to a 401, not a 201', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'nobody', email: 'nobody@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(401);

    const user = await db('users').where({ username: 'nobody' }).first();
    expect(user).toBeUndefined();
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await signup('erin');
  });

  test('succeeds with correct credentials and audits AUTH_LOGIN', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'erin', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ username: 'erin', displayName: 'erin', isSystemAdmin: false });

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN' }).first();
    expect(row).toBeTruthy();
  });

  // FEATURE_REQUEST.md's "display names as the primary identity" entry:
  // displayName must reflect the stored value, not just echo username back —
  // this is the one test in the file that seeds a display name distinct from
  // the username to actually prove that, rather than the two coincidentally
  // matching everywhere else in this file.
  test('returns a display name distinct from username when one is set', async () => {
    await signup('distinctdn', { displayName: 'Distinct Display Name' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'distinctdn', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'distinctdn', displayName: 'Distinct Display Name' });
  });

  // FEATURE_REQUEST.md entry 1, slice 3: the frontend needs isSystemAdmin to
  // gate system-admin-only UI (e.g. "Create organization…") without an
  // attempt-then-403 workaround.
  test('reflects is_system_admin: true once a user is promoted', async () => {
    await db('users').where({ username: 'erin' }).update({ is_system_admin: true });
    const res = await request(app).post('/api/auth/login').send({ username: 'erin', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.user.isSystemAdmin).toBe(true);
  });

  test('fails with wrong password and audits AUTH_LOGIN_FAILURE against the real user', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'erin', password: 'wrong-password' });
    expect(res.status).toBe(401);

    const user = await db('users').where({ username: 'erin' }).first('id');
    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN_FAILURE' }).first();
    expect(row.actor_id).toBe(user.id);
  });

  test('fails for an unknown username and audits AUTH_LOGIN_FAILURE against the anonymous actor', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'no-such-user', password: 'whatever12' });
    expect(res.status).toBe(401);

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN_FAILURE' }).first();
    expect(row.actor_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(row.target_resource).toBe('no-such-user');
  });
});

// New (FEATURE_REQUEST.md entry 1, slice 4): account lifecycle enforcement.
describe('Account status: disabled users', () => {
  test('login rejects a DISABLED user with the same generic message as a wrong password', async () => {
    const user = await signup('disableduser0');
    await db('users').where({ id: user.userId }).update({ status: 'DISABLED' });

    const res = await request(app).post('/api/auth/login').send({ username: 'disableduser0', password: 'correct-horse-battery' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN_FAILURE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ reason: 'disabled' });
  });

  // Pins decision 12 (SLICE_4_PLAN.md): no code change needed in
  // POST /refresh itself — disabling a user already revokes every
  // outstanding refresh token (the same call admin.js's disable route
  // makes), so the existing reuse-detection branch already 401s.
  test('refresh 401s after disable, with no route code change needed', async () => {
    const user = await signup('disableduser1');
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'disableduser1', password: 'correct-horse-battery' });
    const cookie = extractCookie(loginRes, 'refresh_token');

    await db('users').where({ id: user.userId }).update({ status: 'DISABLED' });
    await revokeAllRefreshTokensForUser(db, user.userId);

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(refreshRes.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  async function signupAndGetCookie() {
    await signup('frank');
    const res = await request(app).post('/api/auth/login').send({ username: 'frank', password: 'correct-horse-battery' });
    return extractCookie(res, 'refresh_token');
  }

  test('rotates the refresh token and issues a new access token', async () => {
    const cookie = await signupAndGetCookie();

    const res = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const newCookie = extractCookie(res, 'refresh_token');
    expect(newCookie).toBeTruthy();
    expect(newCookie).not.toBe(cookie);
  });

  // Regression guard (FEATURE_REQUEST.md entry 1, slice 3): /refresh has
  // never returned a user object (AuthContext.restoreSession() calls
  // GET /me separately for that) — isSystemAdmin exposure deliberately did
  // not add one here, and this pins that down.
  test('response shape stays {accessToken} only — no user key', async () => {
    const cookie = await signupAndGetCookie();
    const res = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['accessToken']);
  });

  test('rejects reuse of an already-rotated refresh token and revokes the session', async () => {
    const cookie = await signupAndGetCookie();

    // First refresh succeeds and rotates the token.
    const first = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(first.status).toBe(200);
    const rotatedCookie = extractCookie(first, 'refresh_token');

    // Replaying the OLD (now-revoked) token is reuse — must fail.
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(replay.status).toBe(401);

    const reuseEvent = await db('audit_logs').where({ action_type: 'AUTH_REFRESH_REUSE_DETECTED' }).first();
    expect(reuseEvent).toBeTruthy();

    // Reuse detection revokes every outstanding token for the user —
    // including the one that was legitimately just issued by the first
    // refresh above.
    const secondUseOfRotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`refresh_token=${rotatedCookie}`]);
    expect(secondUseOfRotated.status).toBe(401);
  });

  test('rejects a missing refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  test('revokes the refresh token so it can no longer be used', async () => {
    await signup('grace');
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'grace', password: 'correct-horse-battery' });
    const cookie = extractCookie(loginRes, 'refresh_token');

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', [`refresh_token=${cookie}`]);
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${cookie}`]);
    expect(refreshRes.status).toBe(401);

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGOUT' }).first();
    expect(row).toBeTruthy();
  });
});

describe('POST /api/auth/change-password', () => {
  async function signupUser(username) {
    const seeded = await signup(username);
    const loginRes = await request(app).post('/api/auth/login').send({ username, password: 'correct-horse-battery' });
    return { accessToken: loginRes.body.accessToken, refreshCookie: extractCookie(loginRes, 'refresh_token'), userId: seeded.userId };
  }

  test('rejects a wrong currentPassword with 401 and does not change the password', async () => {
    const { accessToken } = await signupUser('ivan');

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(accessToken))
      .send({ currentPassword: 'totally-wrong', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);

    // The old password still works.
    const loginRes = await request(app).post('/api/auth/login').send({ username: 'ivan', password: 'correct-horse-battery' });
    expect(loginRes.status).toBe(200);
  });

  test('rejects a newPassword that fails the password policy', async () => {
    const { accessToken } = await signupUser('julia');

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(accessToken))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('succeeds: new tokens work, the old password no longer works, and AUTH_PASSWORD_CHANGE is audited', async () => {
    const { accessToken, userId } = await signupUser('karl');

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(accessToken))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ username: 'karl', displayName: 'karl', isSystemAdmin: false });

    const oldPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'karl', password: 'correct-horse-battery' });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await request(app).post('/api/auth/login').send({ username: 'karl', password: 'a-brand-new-password' });
    expect(newPasswordLogin.status).toBe(200);

    const row = await db('audit_logs').where({ action_type: 'AUTH_PASSWORD_CHANGE' }).first();
    expect(row.actor_id).toBe(userId);
  });

  test('the current session keeps working via the freshly issued refresh token, but the pre-change refresh token is revoked', async () => {
    const { accessToken, refreshCookie } = await signupUser('liam');

    const changeRes = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(accessToken))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' });
    expect(changeRes.status).toBe(200);
    const newRefreshCookie = extractCookie(changeRes, 'refresh_token');
    expect(newRefreshCookie).toBeTruthy();
    expect(newRefreshCookie).not.toBe(refreshCookie);

    // Check the newly issued token *first* — replaying the pre-change
    // (already-revoked) token trips reuse detection, which itself revokes
    // every outstanding token including the fresh one, so asserting in the
    // other order would make this test's own old-token check clobber the
    // very thing it's trying to prove still works.
    const newRefreshAttempt = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${newRefreshCookie}`]);
    expect(newRefreshAttempt.status).toBe(200);

    // The pre-change refresh token was revoked along with every other
    // outstanding token for this user.
    const oldRefreshAttempt = await request(app).post('/api/auth/refresh').set('Cookie', [`refresh_token=${refreshCookie}`]);
    expect(oldRefreshAttempt.status).toBe(401);
  });

  test('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'whatever', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);
  });
});

// FEATURE_REQUEST.md's "display names settable in the admin account-creation
// worksheet" entry: closes the gap where a system admin could set a display
// name at account-creation time but the account holder had no way to ever
// change it themselves.
describe('PATCH /api/auth/me/display-name', () => {
  test("updates only the caller's own row and is reflected in a subsequent GET /auth/me", async () => {
    const mia = await signup('mia');
    const other = await signup('miaother');

    const res = await request(app)
      .patch('/api/auth/me/display-name')
      .set(authHeader(mia.accessToken))
      .send({ displayName: 'Mia Updated' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'mia', displayName: 'Mia Updated' });

    const meRes = await request(app).get('/api/auth/me').set(authHeader(mia.accessToken));
    expect(meRes.body.user.displayName).toBe('Mia Updated');

    // The other account's row is untouched.
    const otherRow = await db('users').where({ id: other.userId }).first('display_name');
    expect(otherRow.display_name).toBe('miaother');
  });

  // Structural: the route has no :userId param at all — it can only ever
  // act on the caller's own row, the same "personal profile data" class as
  // POST /auth/change-password. There is no way to pass a target id.
  test('accepts no target-user parameter — always acts on the caller alone', async () => {
    const nina = await signup('nina');
    const res = await request(app)
      .patch('/api/auth/me/display-name')
      .set(authHeader(nina.accessToken))
      .send({ displayName: 'Nina Renamed', userId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(200);

    const row = await db('users').where({ id: nina.userId }).first('display_name');
    expect(row.display_name).toBe('Nina Renamed');
  });

  test('rejects an empty displayName', async () => {
    const oscar = await signup('oscar');
    const res = await request(app)
      .patch('/api/auth/me/display-name')
      .set(authHeader(oscar.accessToken))
      .send({ displayName: '' });
    expect(res.status).toBe(400);

    const row = await db('users').where({ id: oscar.userId }).first('display_name');
    expect(row.display_name).toBe('oscar');
  });

  test('rejects an over-length displayName', async () => {
    const petra = await signup('petra');
    const res = await request(app)
      .patch('/api/auth/me/display-name')
      .set(authHeader(petra.accessToken))
      .send({ displayName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  test('rejects an unauthenticated request', async () => {
    const res = await request(app).patch('/api/auth/me/display-name').send({ displayName: 'Nobody' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  test('returns the current user for a valid access token', async () => {
    const henry = await signup('henry');

    const res = await request(app).get('/api/auth/me').set(authHeader(henry.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: 'henry',
      displayName: 'henry',
      email: 'henry@example.com',
      isSystemAdmin: false,
    });
  });

  test('reflects is_system_admin: true once a user is promoted', async () => {
    const iris = await signup('iris');
    await db('users').where({ username: 'iris' }).update({ is_system_admin: true });

    const res = await request(app).get('/api/auth/me').set(authHeader(iris.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.isSystemAdmin).toBe(true);
  });

  test('rejects a missing or invalid access token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
