import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

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

async function makeSystemAdmin(userId) {
  await db('users').where({ id: userId }).update({ is_system_admin: true });
}

async function createOrg(sysAdmin, name) {
  const res = await request(app).post('/api/organizations').set(authHeader(sysAdmin.accessToken)).send({ name });
  return res.body;
}

describe('POST /api/workspaces organizationId resolution', () => {
  test('omitted, caller in exactly one org -> unchanged 201 (today\'s no-op default)', async () => {
    const user = await signup(app, 'wsorg0');
    const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
    expect(res.status).toBe(201);

    const earliestOrg = await db('organizations').orderBy('created_at', 'asc').first('id');
    const ws = await db('workspaces').where({ id: res.body.id }).first('organization_id');
    expect(ws.organization_id).toBe(earliestOrg.id);
  });

  test('explicit organizationId the caller belongs to -> 201, workspace lands in that org', async () => {
    const admin = await signup(app, 'wsorg1');
    await makeSystemAdmin(admin.userId);
    const org = await createOrg(admin, 'WS Org Explicit');

    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org-scoped WS', organizationId: org.id });
    expect(res.status).toBe(201);

    const ws = await db('workspaces').where({ id: res.body.id }).first('organization_id');
    expect(ws.organization_id).toBe(org.id);
  });

  test('explicit organizationId the caller does not belong to -> 404', async () => {
    const admin = await signup(app, 'wsorg2');
    await makeSystemAdmin(admin.userId);
    const org = await createOrg(admin, 'WS Org Not Mine');

    const outsider = await signup(app, 'wsorgoutsider2');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(outsider.accessToken))
      .send({ name: 'Should Fail', organizationId: org.id });
    expect(res.status).toBe(404);
  });

  test('caller belongs to two orgs, organizationId omitted -> 400 ambiguity', async () => {
    const admin = await signup(app, 'wsorg3');
    await makeSystemAdmin(admin.userId);
    const org = await createOrg(admin, 'WS Org Second');
    // admin is now ORG_ADMIN of both the earliest-created org (via signup
    // auto-enrollment) and this new one (via org creation) — two memberships.

    const res = await request(app).post('/api/workspaces').set(authHeader(admin.accessToken)).send({ name: 'Ambiguous' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/more than one organization/i);
  });
});

describe('GET /api/workspaces/discoverable organization scoping', () => {
  test('a second org\'s DISCOVERABLE workspace does not leak into the first org\'s list', async () => {
    const admin = await signup(app, 'wsdisc0');
    await makeSystemAdmin(admin.userId);
    const orgB = await createOrg(admin, 'Org B Discoverable');

    // A workspace explicitly created in org B, discoverable.
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org B Workspace', visibility: 'DISCOVERABLE', organizationId: orgB.id });
    expect(wsB.status).toBe(201);

    // A caller who only belongs to the earliest (default) org.
    const seeker = await signup(app, 'wsdiscseeker0');
    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(seeker.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.id)).not.toContain(wsB.body.id);
  });

  test('explicit organizationId scopes the discoverable list to that org', async () => {
    const admin = await signup(app, 'wsdisc1');
    await makeSystemAdmin(admin.userId);
    const orgB = await createOrg(admin, 'Org B Explicit Discoverable');
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Org B WS Explicit', visibility: 'DISCOVERABLE', organizationId: orgB.id });

    // A different member of org B, not the workspace's own creator/owner —
    // GET /discoverable excludes workspaces the caller already belongs to,
    // so checking with the creator's own token would always exclude it.
    const orgBMember = await signup(app, 'wsdiscorgbmember1');
    await request(app).post(`/api/organizations/${orgB.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'wsdiscorgbmember1' });

    const res = await request(app)
      .get('/api/workspaces/discoverable')
      .query({ organizationId: orgB.id })
      .set(authHeader(orgBMember.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.id)).toContain(wsB.body.id);
  });

  test('explicit organizationId the caller is not a member of 404s', async () => {
    const admin = await signup(app, 'wsdisc2');
    await makeSystemAdmin(admin.userId);
    const org = await createOrg(admin, 'Org Not Mine Discoverable');

    const outsider = await signup(app, 'wsdiscoutsider2');
    const res = await request(app)
      .get('/api/workspaces/discoverable')
      .query({ organizationId: org.id })
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});
