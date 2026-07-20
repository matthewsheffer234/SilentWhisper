import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section): GET /api/direct-messages — no "list my DMs" read endpoint
// existed before this; only create/reopen (POST /direct-messages,
// POST /group-direct-messages).

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('GET /api/direct-messages', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/direct-messages');
    expect(res.status).toBe(401);
  });

  test('returns only the caller\'s own DIRECT and GROUP_DM channels, never someone else\'s', async () => {
    const alice = await signup('dmalice');
    const bob = await signup('dmbob');
    const carol = await signup('dmcarol');
    const outsider = await signup('dmoutsider');

    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: bob.userId });
    expect(dmRes.status).toBe(201);

    const groupRes = await request(app)
      .post('/api/group-direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ memberIds: [bob.userId, carol.userId] });
    expect(groupRes.status).toBe(201);

    const aliceList = await request(app).get('/api/direct-messages').set(authHeader(alice.accessToken));
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.directMessages.map((c) => c.id).sort()).toEqual([dmRes.body.id, groupRes.body.id].sort());
    expect(aliceList.body.total).toBe(2);
    expect(aliceList.body.limit).toBe(50);
    expect(aliceList.body.offset).toBe(0);

    const outsiderList = await request(app).get('/api/direct-messages').set(authHeader(outsider.accessToken));
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body).toEqual({ directMessages: [], total: 0, limit: 50, offset: 0 });
  });

  test('rejects malformed pagination params consistently with the admin routes', async () => {
    const alice = await signup('dmalicepaging');

    const badLimit = await request(app)
      .get('/api/direct-messages?limit=0')
      .set(authHeader(alice.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app)
      .get('/api/direct-messages?offset=-1')
      .set(authHeader(alice.accessToken));
    expect(badOffset.status).toBe(400);
  });

  test('returns a correctly bounded page via limit/offset', async () => {
    const alice = await signup('dmalicepage2');
    const others = await Promise.all(
      Array.from({ length: 3 }, (_, i) => signup(`dmalicepage2peer${i}`)),
    );
    for (const other of others) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post('/api/direct-messages')
        .set(authHeader(alice.accessToken))
        .send({ targetUserId: other.userId });
    }

    const page1 = await request(app)
      .get('/api/direct-messages?limit=2&offset=0')
      .set(authHeader(alice.accessToken));
    expect(page1.status).toBe(200);
    expect(page1.body.directMessages).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await request(app)
      .get('/api/direct-messages?limit=2&offset=2')
      .set(authHeader(alice.accessToken));
    expect(page2.status).toBe(200);
    expect(page2.body.directMessages).toHaveLength(1);
    expect(page2.body.total).toBe(3);

    const page1Ids = page1.body.directMessages.map((c) => c.id);
    const page2Ids = page2.body.directMessages.map((c) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(3);
  });

  test('members array excludes the caller and includes displayName/username for every other participant', async () => {
    const alice = await signup('dmalice2', { displayName: 'Alice A' });
    const bob = await signup('dmbob2', { displayName: 'Bob B' });
    const carol = await signup('dmcarol2', { displayName: 'Carol C' });

    const groupRes = await request(app)
      .post('/api/group-direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ memberIds: [bob.userId, carol.userId] });

    const list = await request(app).get('/api/direct-messages').set(authHeader(alice.accessToken));
    const group = list.body.directMessages.find((c) => c.id === groupRes.body.id);
    expect(group.type).toBe('GROUP_DM');
    expect(group.members.map((m) => m.userId).sort()).toEqual([bob.userId, carol.userId].sort());
    expect(group.members.every((m) => m.userId !== alice.userId)).toBe(true);
    expect(group.members.map((m) => m.displayName).sort()).toEqual(['Bob B', 'Carol C']);
  });

  test('lastMessage reflects the most recent top-level message, null when the DM has none yet', async () => {
    const alice = await signup('dmalice3');
    const bob = await signup('dmbob3');

    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: bob.userId });

    const emptyList = await request(app).get('/api/direct-messages').set(authHeader(alice.accessToken));
    expect(emptyList.body.directMessages.find((c) => c.id === dmRes.body.id).lastMessage).toBeNull();

    await request(app)
      .post(`/api/channels/${dmRes.body.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: 'hello there' });

    const list = await request(app).get('/api/direct-messages').set(authHeader(bob.accessToken));
    const dm = list.body.directMessages.find((c) => c.id === dmRes.body.id);
    expect(dm.lastMessage.content).toBe('hello there');
    expect(dm.lastMessage.userId).toBe(alice.userId);
  });

  test('is sorted by most recent activity first', async () => {
    const alice = await signup('dmalice4');
    const bob = await signup('dmbob4');
    const carol = await signup('dmcarol4');

    const dmBob = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: bob.userId });
    const dmCarol = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: carol.userId });

    // Send into the *first*-created DM last, so activity order and creation
    // order disagree — proving the sort really is by last-activity, not
    // insertion order.
    await request(app)
      .post(`/api/channels/${dmBob.body.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: 'to bob, sent last' });

    const list = await request(app).get('/api/direct-messages').set(authHeader(alice.accessToken));
    expect(list.body.directMessages[0].id).toBe(dmBob.body.id);
    expect(list.body.directMessages.some((c) => c.id === dmCarol.body.id)).toBe(true);
  });
});

// supertest/superagent's Test is lazy: constructing it (even with .send())
// does nothing over the wire until it's awaited/`.then()`-ed — so firing two
// requests genuinely concurrently requires explicitly kicking each off via
// .end(), wrapped back into a plain Promise. Same helper as aiRoutes.test.js.
function fireNow(req) {
  return new Promise((resolve, reject) => {
    req.end((err, res) => {
      if (err && !res) reject(err);
      else resolve(res);
    });
  });
}

// docs/reviews/security-performance-review-2026-07-19.md Finding 9 (Low):
// two people clicking "Message" on each other in the same window could each
// pass the "no existing channel" check under READ COMMITTED and create two
// separate DIRECT channels for the same pair. Fixed with a
// pg_advisory_xact_lock keyed on the sorted user-id pair inside the
// transaction.
describe('POST /api/direct-messages concurrency', () => {
  test('two concurrent requests for the same pair resolve to the same channel, with exactly one created: true', async () => {
    const a = await signup('dmraceuser1');
    const b = await signup('dmraceuser2');

    const [firstRes, secondRes] = await Promise.all([
      fireNow(request(app).post('/api/direct-messages').set(authHeader(a.accessToken)).send({ targetUserId: b.userId })),
      fireNow(request(app).post('/api/direct-messages').set(authHeader(b.accessToken)).send({ targetUserId: a.userId })),
    ]);

    expect([firstRes.status, secondRes.status].sort()).toEqual([200, 201]);
    expect(firstRes.body.id).toBe(secondRes.body.id);

    const createdCount = [firstRes, secondRes].filter((r) => r.status === 201).length;
    expect(createdCount).toBe(1);

    const channels = await db('channels').where({ type: 'DIRECT' });
    expect(channels).toHaveLength(1);
  });

  test('existing single-caller behavior is unaffected: reusing a DM still returns 200 with the same id', async () => {
    const a = await signup('dmraceuser3');
    const b = await signup('dmraceuser4');

    const first = await request(app).post('/api/direct-messages').set(authHeader(a.accessToken)).send({ targetUserId: b.userId });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/direct-messages').set(authHeader(a.accessToken)).send({ targetUserId: b.userId });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });
});

// Security.md (2026-07-15, LOW: "Group DM Creation Allows Unbounded Member
// Arrays") — memberIds previously had no maximum, only a non-empty check
// and per-element UUID validation.
describe('POST /api/group-direct-messages', () => {
  test('rejects a memberIds array larger than the product-level cap, before touching the database', async () => {
    const alice = await signup('groupdmcapalice0');
    const oversized = Array.from({ length: 21 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/group-direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ memberIds: oversized });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 20 users/);

    const channels = await db('channels').where({ type: 'GROUP_DM' });
    expect(channels).toHaveLength(0);
  });

  test('accepts a memberIds array at exactly the cap', async () => {
    const alice = await signup('groupdmcapalice1');
    const others = [];
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      others.push(await signup(`groupdmcapmember1_${i}`));
    }

    const res = await request(app)
      .post('/api/group-direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ memberIds: others.map((u) => u.userId) });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/organizations/:orgId/members-search', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/organizations/00000000-0000-0000-0000-000000000000/members-search');
    expect(res.status).toBe(401);
  });

  test('a non-member of the organization gets 404, not 403 (existence-hiding)', async () => {
    const admin = await seedSystemAdmin('orgmsadmin0');
    const orgRes = await request(app)
      .post('/api/organizations')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Members Search Org' });
    const orgId = orgRes.body.id;

    const outsider = await signup('orgmsoutsider0');
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-search`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('an ordinary org member (not just ORG_MANAGE_MEMBERS) can search the roster, excludes self, matches by prefix', async () => {
    const orgRow = await db('organizations').orderBy('created_at', 'asc').first('id');
    const orgId = orgRow.id;

    const alice = await signup('orgmsalice1');
    const albert = await signup('orgmsalbert1');
    const bob = await signup('orgmsbob1');

    const prefixRes = await request(app)
      .get(`/api/organizations/${orgId}/members-search?q=orgmsal`)
      .set(authHeader(alice.accessToken));
    expect(prefixRes.status).toBe(200);
    expect(prefixRes.body.map((r) => r.username).sort()).toEqual(['orgmsalbert1']);

    const noQueryRes = await request(app)
      .get(`/api/organizations/${orgId}/members-search`)
      .set(authHeader(alice.accessToken));
    expect(noQueryRes.status).toBe(200);
    expect(noQueryRes.body.some((r) => r.userId === alice.userId)).toBe(false);
    expect(noQueryRes.body.some((r) => r.userId === albert.userId)).toBe(true);
    expect(noQueryRes.body.some((r) => r.userId === bob.userId)).toBe(true);
    expect(Object.keys(noQueryRes.body[0]).sort()).toEqual(['displayName', 'userId', 'username']);
  });

  test('a nonexistent organization id 404s', async () => {
    const user = await signup('orgmsuser2');
    const res = await request(app)
      .get('/api/organizations/00000000-0000-0000-0000-000000000000/members-search')
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(404);
  });

  test('a malformed orgId 400s', async () => {
    const user = await signup('orgmsuser3');
    const res = await request(app).get('/api/organizations/not-a-uuid/members-search').set(authHeader(user.accessToken));
    expect(res.status).toBe(400);
  });
});
