import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';

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
    expect(res.body.user).toMatchObject({ username: 'alice', email: 'alice@example.com' });

    const cookie = extractCookie(res, 'refresh_token');
    expect(cookie).toBeTruthy();
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Strict/i);

    const row = await db('audit_logs').where({ action_type: 'AUTH_SIGNUP' }).first();
    expect(row).toBeTruthy();
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

    const row = await db('audit_logs').where({ action_type: 'AUTH_LOGIN' }).first();
    expect(row).toBeTruthy();
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
