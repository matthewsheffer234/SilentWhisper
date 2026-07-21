import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { createOrg } from './helpers/fixtures.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 2:
// POST /workspaces and GET /workspaces/discoverable become org-aware, with
// organizationId optional and a backward-compatible default-to-sole-org
// resolution (resolveCallerOrganization in workspaces.js).

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('POST /api/workspaces organizationId resolution', () => {
  test('omitted, caller in exactly one org -> unchanged 201 (today\'s no-op default)', async () => {
    const user = await signup('wsorg0');
    const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
    expect(res.status).toBe(201);

    const earliestOrg = await db('organizations').orderBy('created_at', 'asc').first('id');
    const ws = await db('workspaces').where({ id: res.body.id }).first('organization_id');
    expect(ws.organization_id).toBe(earliestOrg.id);
  });

  test('explicit organizationId the caller belongs to -> 201, workspace lands in that org', async () => {
    const admin = await seedSystemAdmin('wsorg1');
    const org = await createOrg(admin.accessToken, 'WS Org Explicit');

    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org-scoped WS', organizationId: org.id });
    expect(res.status).toBe(201);

    const ws = await db('workspaces').where({ id: res.body.id }).first('organization_id');
    expect(ws.organization_id).toBe(org.id);
  });

  test('explicit organizationId the caller does not belong to -> 404', async () => {
    const admin = await seedSystemAdmin('wsorg2');
    const org = await createOrg(admin.accessToken, 'WS Org Not Mine');

    const outsider = await signup('wsorgoutsider2');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(outsider.accessToken))
      .send({ name: 'Should Fail', organizationId: org.id });
    expect(res.status).toBe(404);
  });

  test('caller belongs to two orgs, organizationId omitted -> 400 ambiguity', async () => {
    const admin = await seedSystemAdmin('wsorg3');
    const org = await createOrg(admin.accessToken, 'WS Org Second');
    // admin is now ORG_ADMIN of both the earliest-created org (via signup
    // auto-enrollment) and this new one (via org creation) — two memberships.

    const res = await request(app).post('/api/workspaces').set(authHeader(admin.accessToken)).send({ name: 'Ambiguous' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/more than one organization/i);
  });
});

describe('GET /api/workspaces organizationId field and filter (slice 3)', () => {
  test('each workspace row includes its own organizationId', async () => {
    const user = await signup('wsorgfield0');
    const createRes = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'Field WS' });

    const res = await request(app).get('/api/workspaces').set(authHeader(user.accessToken));
    expect(res.status).toBe(200);
    const row = res.body.workspaces.find((w) => w.id === createRes.body.id);
    const wsRow = await db('workspaces').where({ id: createRes.body.id }).first('organization_id');
    expect(row.organizationId).toBe(wsRow.organization_id);
  });

  test('?organizationId= filters to only that org\'s workspaces', async () => {
    const admin = await seedSystemAdmin('wsorgfilter0');
    const earliestOrg = await db('organizations').orderBy('created_at', 'asc').first('id');
    const orgB = await createOrg(admin.accessToken, 'Filter Org B');

    // admin now belongs to 2 orgs (default + orgB), so organizationId must be
    // explicit for both — otherwise POST /workspaces 400s on ambiguity.
    const wsA = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Filter WS A', organizationId: earliestOrg.id });
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Filter WS B', organizationId: orgB.id });
    expect(wsA.status).toBe(201);
    expect(wsB.status).toBe(201);
    const filteredA = await request(app)
      .get('/api/workspaces')
      .query({ organizationId: earliestOrg.id })
      .set(authHeader(admin.accessToken));
    expect(filteredA.body.workspaces.map((w) => w.id)).toContain(wsA.body.id);
    expect(filteredA.body.workspaces.map((w) => w.id)).not.toContain(wsB.body.id);

    const filteredB = await request(app)
      .get('/api/workspaces')
      .query({ organizationId: orgB.id })
      .set(authHeader(admin.accessToken));
    expect(filteredB.body.workspaces.map((w) => w.id)).toContain(wsB.body.id);
    expect(filteredB.body.workspaces.map((w) => w.id)).not.toContain(wsA.body.id);
  });

  test('?organizationId= for an org the caller has no relationship to returns an empty array, not an error', async () => {
    const admin = await seedSystemAdmin('wsorgfilter1');
    const orgB = await createOrg(admin.accessToken, 'Filter Org C');

    const outsider = await signup('wsorgfilteroutsider1');
    const outsiderWs = await request(app).post('/api/workspaces').set(authHeader(outsider.accessToken)).send({ name: 'Outsider WS' });
    expect(outsiderWs.status).toBe(201);

    const res = await request(app)
      .get('/api/workspaces')
      .query({ organizationId: orgB.id })
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(200);
    // Outsider does have a workspace (in their own default org) — proves the
    // empty result comes from the orgB filter narrowing an already-scoped
    // result set to nothing, not from having no workspaces at all.
    expect(res.body.workspaces).toEqual([]);
  });
});

describe('GET /api/workspaces/discoverable organization scoping', () => {
  test('a second org\'s DISCOVERABLE workspace does not leak into the first org\'s list', async () => {
    const admin = await seedSystemAdmin('wsdisc0');
    const orgB = await createOrg(admin.accessToken, 'Org B Discoverable');

    // A workspace explicitly created in org B, discoverable.
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org B Workspace', visibility: 'DISCOVERABLE', organizationId: orgB.id });
    expect(wsB.status).toBe(201);

    // A caller who only belongs to the earliest (default) org.
    const seeker = await signup('wsdiscseeker0');
    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(seeker.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.workspaces.map((w) => w.id)).not.toContain(wsB.body.id);
  });

  test('explicit organizationId scopes the discoverable list to that org', async () => {
    const admin = await seedSystemAdmin('wsdisc1');
    const orgB = await createOrg(admin.accessToken, 'Org B Explicit Discoverable');
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org B WS Explicit', visibility: 'DISCOVERABLE', organizationId: orgB.id });

    // A different member of org B, not the workspace's own creator/owner —
    // GET /discoverable excludes workspaces the caller already belongs to,
    // so checking with the creator's own token would always exclude it.
    const orgBMember = await signup('wsdiscorgbmember1');
    await request(app).post(`/api/organizations/${orgB.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'wsdiscorgbmember1' });

    const res = await request(app)
      .get('/api/workspaces/discoverable')
      .query({ organizationId: orgB.id })
      .set(authHeader(orgBMember.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.workspaces.map((w) => w.id)).toContain(wsB.body.id);
  });

  test('explicit organizationId the caller is not a member of 404s', async () => {
    const admin = await seedSystemAdmin('wsdisc2');
    const org = await createOrg(admin.accessToken, 'Org Not Mine Discoverable');

    const outsider = await signup('wsdiscoutsider2');
    const res = await request(app)
      .get('/api/workspaces/discoverable')
      .query({ organizationId: org.id })
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

// Finding 3, docs/reviews/security-performance-review-2026-07-20.md:
// GET /workspaces and GET /workspaces/discoverable were both genuinely
// unbounded — no `.limit()` at all. Same {<resource>, total, limit, offset}
// shape and same malformed-params/bounded-page coverage as the six routes
// the 2026-07-20 pagination pass already fixed.
describe('GET /api/workspaces and GET /api/workspaces/discoverable pagination', () => {
  test('GET /api/workspaces rejects malformed pagination params and returns a correctly bounded page', async () => {
    const user = await signup('wspaging0');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: `Paging WS ${i}` });
    }

    const badLimit = await request(app).get('/api/workspaces?limit=0').set(authHeader(user.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app).get('/api/workspaces?offset=-1').set(authHeader(user.accessToken));
    expect(badOffset.status).toBe(400);

    const page = await request(app).get('/api/workspaces?limit=2&offset=0').set(authHeader(user.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.workspaces).toHaveLength(2);
    expect(page.body.total).toBeGreaterThanOrEqual(3);
    expect(page.body.limit).toBe(2);
    expect(page.body.offset).toBe(0);
  });

  test('GET /api/workspaces/discoverable rejects malformed pagination params and returns a correctly bounded page', async () => {
    const admin = await seedSystemAdmin('wsdiscpaging0');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post('/api/workspaces')
        .set(authHeader(admin.accessToken))
        .send({ name: `Discoverable Paging ${i}`, visibility: 'DISCOVERABLE' });
    }
    const seeker = await signup('wsdiscpagingseeker0');

    const badLimit = await request(app)
      .get('/api/workspaces/discoverable?limit=0')
      .set(authHeader(seeker.accessToken));
    expect(badLimit.status).toBe(400);

    const page = await request(app)
      .get('/api/workspaces/discoverable?limit=2&offset=0')
      .set(authHeader(seeker.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.workspaces).toHaveLength(2);
    expect(page.body.total).toBeGreaterThanOrEqual(3);
  });
});
