import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { authHeader } from './helpers/testUsers.js';

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

describe('POST /api/auth/signup', () => {
  test('creates a user and issues an access token + refresh cookie', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'alice', email: 'alice@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ username: 'alice', email: 'alice@example.com', isSystemAdmin: false });

    const cookie = extractCookie(res, 'refresh_token');
    expect(cookie).toBeTruthy();
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Strict/i);

    const row = await db('audit_logs').where({ action_type: 'AUTH_SIGNUP' }).first();
    expect(row).toBeTruthy();
  });

  // FEATURE_REQUEST.md entry 1, slice 2: signup stays open, so every fresh
  // account still needs an organization_members row for POST /workspaces'
  // org-aware default-to-sole-org logic to have something to resolve
  // against.
  test('enrolls the new user into the earliest-created organization as ORG_MEMBER', async () => {
    const earliestOrg = await db('organizations').orderBy('created_at', 'asc').first('id');

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'enrollee', email: 'enrollee@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);

    const memberships = await db('organization_members').where({ user_id: res.body.user.id });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organization_id: earliestOrg.id, org_role: 'ORG_MEMBER' });
  });

  test('rejects a password shorter than the minimum length', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'bob', email: 'bob@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  test('rejects a common password even if long enough', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'carol', email: 'carol@example.com', password: 'password123' });
    expect(res.status).toBe(400);
  });

  test('rejects a duplicate username or email with the same generic message either way', async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ username: 'dave', email: 'dave@example.com', password: 'correct-horse-battery' });

    const duplicateUsername = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'dave', email: 'someone-else@example.com', password: 'correct-horse-battery' });
    const duplicateEmail = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'someone-else', email: 'dave@example.com', password: 'correct-horse-battery' });

    expect(duplicateUsername.status).toBe(409);
    expect(duplicateEmail.status).toBe(409);
    // Same message regardless of which field actually collided — an
    // attacker can't use this endpoint to enumerate which usernames/emails
    // already exist by comparing error text.
    expect(duplicateUsername.body.error).toBe(duplicateEmail.body.error);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ username: 'erin', email: 'erin@example.com', password: 'correct-horse-battery' });
  });

  test('succeeds with correct credentials and audits AUTH_LOGIN', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'erin', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ username: 'erin', isSystemAdmin: false });

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN' }).first();
    expect(row).toBeTruthy();
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

describe('POST /api/auth/refresh', () => {
  async function signupAndGetCookie() {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'frank', email: 'frank@example.com', password: 'correct-horse-battery' });
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
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'grace', email: 'grace@example.com', password: 'correct-horse-battery' });
    const cookie = extractCookie(signupRes, 'refresh_token');

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
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ username, email: `${username}@example.com`, password: 'correct-horse-battery' });
    return { accessToken: res.body.accessToken, refreshCookie: extractCookie(res, 'refresh_token'), userId: res.body.user.id };
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
    expect(res.body.user).toMatchObject({ username: 'karl', isSystemAdmin: false });

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

describe('GET /api/auth/me', () => {
  test('returns the current user for a valid access token', async () => {
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'henry', email: 'henry@example.com', password: 'correct-horse-battery' });

    const res = await request(app).get('/api/auth/me').set(authHeader(signupRes.body.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'henry', email: 'henry@example.com', isSystemAdmin: false });
  });

  test('reflects is_system_admin: true once a user is promoted', async () => {
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'iris', email: 'iris@example.com', password: 'correct-horse-battery' });
    await db('users').where({ username: 'iris' }).update({ is_system_admin: true });

    const res = await request(app).get('/api/auth/me').set(authHeader(signupRes.body.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.isSystemAdmin).toBe(true);
  });

  test('rejects a missing or invalid access token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
