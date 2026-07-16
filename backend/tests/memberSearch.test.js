import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md's @mention autocomplete entry: GET
// /channels/:channelId/members?q=&limit=. No such "who is in this channel"
// read endpoint existed before this — every prior channel_members touch
// point was a POST or an internal-only check.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspace(user) {
  const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
  return res.body.id;
}

async function createChannel(user, workspaceId) {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  return res.body.id;
}

// Adding a user to a channel (POST .../channels/:channelId/members)
// requires the target to already be a *workspace* member — invite them
// first, then self-join the PUBLIC channel with their own token.
async function addToChannel(admin, workspaceId, channelId, member) {
  const inviteRes = await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(admin.accessToken))
    .send({ username: member.username });
  if (inviteRes.status !== 201 && inviteRes.status !== 200) {
    throw new Error(`invite failed: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  }
  const joinRes = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
    .set(authHeader(member.accessToken));
  if (joinRes.status >= 300) {
    throw new Error(`join failed: ${joinRes.status} ${JSON.stringify(joinRes.body)}`);
  }
}

describe('GET /channels/:channelId/members', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/channels/00000000-0000-0000-0000-000000000000/members');
    expect(res.status).toBe(401);
  });

  test('a non-member gets 404, never a 403 (Section 3, existence-hiding)', async () => {
    const owner = await signup('msearchowner0');
    const outsider = await signup('msearchoutsider0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    const res = await request(app).get(`/api/channels/${channelId}/members`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('a nonexistent channel id also 404s, indistinguishable from a real channel the caller cannot see', async () => {
    const user = await signup('msearchuser0');
    const res = await request(app)
      .get('/api/channels/00000000-0000-0000-0000-000000000000/members')
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(404);
  });

  test('a malformed channelId 400s', async () => {
    const user = await signup('msearchuser1');
    const res = await request(app).get('/api/channels/not-a-uuid/members').set(authHeader(user.accessToken));
    expect(res.status).toBe(400);
  });

  test('prefix matching is case-insensitive and resolves partial usernames, excludes the caller, and omits with no query returns alphabetically', async () => {
    const owner = await signup('msearchowner1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);

    const alice = await signup('alicesmith');
    const albert = await signup('albertjones');
    const bob = await signup('bobwhite');
    for (const u of [alice, albert, bob]) {
      // eslint-disable-next-line no-await-in-loop
      await addToChannel(owner, workspaceId, channelId, u);
    }

    const prefixRes = await request(app)
      .get(`/api/channels/${channelId}/members?q=AL`)
      .set(authHeader(owner.accessToken));
    expect(prefixRes.status).toBe(200);
    expect(prefixRes.body.map((r) => r.username).sort()).toEqual(['albertjones', 'alicesmith']);

    const noQueryRes = await request(app).get(`/api/channels/${channelId}/members`).set(authHeader(owner.accessToken));
    expect(noQueryRes.status).toBe(200);
    // Alphabetical, and the caller (owner) excluded from their own results.
    expect(noQueryRes.body.map((r) => r.username)).toEqual(['albertjones', 'alicesmith', 'bobwhite']);
    expect(noQueryRes.body.some((r) => r.username === owner.username)).toBe(false);

    // Lean shape — no email or other fields; displayName joins alongside
    // username (FEATURE_REQUEST.md's "display names as the primary
    // identity" entry) for the mention-autocomplete dropdown to render.
    expect(Object.keys(noQueryRes.body[0]).sort()).toEqual(['displayName', 'id', 'username']);
    expect(noQueryRes.body.map((r) => r.displayName).sort()).toEqual(['albertjones', 'alicesmith', 'bobwhite']);
  });

  test('results are capped at the configured limit', async () => {
    const owner = await signup('msearchowner2');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const u = await signup(`capuser${i}`);
      // eslint-disable-next-line no-await-in-loop
      await addToChannel(owner, workspaceId, channelId, u);
    }

    const defaultRes = await request(app).get(`/api/channels/${channelId}/members`).set(authHeader(owner.accessToken));
    expect(defaultRes.body).toHaveLength(8);

    const limitedRes = await request(app)
      .get(`/api/channels/${channelId}/members?limit=3`)
      .set(authHeader(owner.accessToken));
    expect(limitedRes.body).toHaveLength(3);

    const overLimitRes = await request(app)
      .get(`/api/channels/${channelId}/members?limit=100`)
      .set(authHeader(owner.accessToken));
    expect(overLimitRes.status).toBe(400);
  });

  // memberSearchLimiter is skip()-ed under NODE_ENV=test (same convention
  // llm/aiRateLimit.js's aiProxyRateLimiter already establishes and this
  // suite already leaves untested for that same reason) — a real test run
  // legitimately hits this endpoint far more than any real-traffic ceiling
  // from one address, which isn't the abuse pattern the limiter exists to
  // catch. No 429 test here for the same reason none exists for
  // aiProxyRateLimiter.
});
