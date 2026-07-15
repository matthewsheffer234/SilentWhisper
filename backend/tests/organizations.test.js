import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 2.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

// Kept local (not promoted to fixtures.js): this file tests organization
// creation itself, so it needs the full supertest response (status *and*
// body), unlike invitations.test.js/workspaceOrganizations.test.js, which
// only use createOrg as setup and share fixtures.js's body-only version.
async function createOrg(sysAdmin, name = 'Acme Org') {
  const res = await request(app).post('/api/organizations').set(authHeader(sysAdmin.accessToken)).send({ name });
  return res;
}

describe('POST /api/organizations', () => {
  test('a system admin can create an organization and is auto-enrolled as ORG_ADMIN', async () => {
    const admin = await seedSystemAdmin('orgcreator0');

    const res = await createOrg(admin, 'Org A');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Org A', role: 'ORG_ADMIN' });

    const membership = await db('organization_members').where({ organization_id: res.body.id, user_id: admin.userId }).first();
    expect(membership.org_role).toBe('ORG_ADMIN');

    const row = await db('audit_logs').where({ action_type: 'ORGANIZATION_CREATED' }).first();
    expect(row.target_resource).toBe(res.body.id);
  });

  test('a non-system-admin gets 403', async () => {
    const user = await signup('orgcreator1');
    const res = await createOrg(user, 'Org B');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/organizations', () => {
  test('a plain (non-system-admin) user sees only their own orgs, with role', async () => {
    const admin = await seedSystemAdmin('orglist0');
    const orgRes = await createOrg(admin, 'Org List Test');

    // A non-system-admin so the response exercises the join-based "caller's
    // own orgs" branch, not the system-admin-sees-all branch (which
    // deliberately reports role: null for every row).
    const member = await signup('orglistmember0');
    await request(app).post(`/api/organizations/${orgRes.body.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'orglistmember0', role: 'ORG_ADMIN' });

    const res = await request(app).get('/api/organizations').set(authHeader(member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: orgRes.body.id, name: 'Org List Test', role: 'ORG_ADMIN' })]),
    );
    // The earliest-created default org (signup auto-enrollment) should also
    // be present, with ORG_MEMBER — confirming the join returns every org
    // this caller belongs to, not just the one just created.
    expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'ORG_MEMBER' })]));
  });

  test('a system admin sees every org, including ones they do not belong to', async () => {
    const admin = await seedSystemAdmin('orglist1');
    const orgRes = await createOrg(admin, 'Org List Test 2');

    const outsider = await seedSystemAdmin('orglistoutsider1');

    const res = await request(app).get('/api/organizations').set(authHeader(outsider.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((o) => o.id)).toContain(orgRes.body.id);
  });
});

describe('org membership routes', () => {
  test('roster/add/role-change/remove work for an ORG_ADMIN, and existence-hiding applies', async () => {
    const admin = await seedSystemAdmin('orgmember0');
    const orgRes = await createOrg(admin, 'Org Membership Test');
    const orgId = orgRes.body.id;

    const target = await signup('orgmembertarget0');
    const addRes = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgmembertarget0' });
    expect(addRes.status).toBe(201);
    expect(addRes.body).toMatchObject({ username: 'orgmembertarget0', role: 'ORG_MEMBER' });

    const rosterRes = await request(app).get(`/api/organizations/${orgId}/members`).set(authHeader(admin.accessToken));
    expect(rosterRes.status).toBe(200);
    expect(rosterRes.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: target.userId, role: 'ORG_MEMBER' })]),
    );

    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/members/${target.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'ORG_ADMIN' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.role).toBe('ORG_ADMIN');

    const deleteRes = await request(app)
      .delete(`/api/organizations/${orgId}/members/${target.userId}`)
      .set(authHeader(admin.accessToken));
    expect(deleteRes.status).toBe(204);

    const gone = await db('organization_members').where({ organization_id: orgId, user_id: target.userId }).first();
    expect(gone).toBeUndefined();
  });

  test('a non-member gets 404 for a real org, not 403', async () => {
    const admin = await seedSystemAdmin('orgmember1');
    const orgRes = await createOrg(admin, 'Org Hidden Test');

    const outsider = await signup('orgoutsider1');
    const res = await request(app).get(`/api/organizations/${orgRes.body.id}/members`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('a nonexistent org 404s the same way', async () => {
    const user = await signup('orgmember2');
    const res = await request(app)
      .get('/api/organizations/00000000-0000-0000-0000-000000000000/members')
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(404);
  });

  test('a plain ORG_MEMBER gets 403 on membership-management routes', async () => {
    const admin = await seedSystemAdmin('orgmember3');
    const orgRes = await createOrg(admin, 'Org Member 403 Test');
    const orgId = orgRes.body.id;

    const member = await signup('orgplainmember3');
    await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgplainmember3' });

    const res = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(member.accessToken))
      .send({ username: 'orgmember3' });
    expect(res.status).toBe(403);
  });

  // FEATURE_REQUEST.md entry 1's locked-in decision: org and workspace
  // membership are independent — removing someone from an org must not
  // touch their workspace_members rows.
  test('removing someone from an org does not cascade to their workspace memberships', async () => {
    const admin = await seedSystemAdmin('orgcascade0');
    const orgRes = await createOrg(admin, 'Org Cascade Test');
    const orgId = orgRes.body.id;

    const member = await signup('orgcascademember0');
    await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgcascademember0' });

    const wsRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(member.accessToken))
      .send({ name: 'Member Workspace', organizationId: orgId });
    expect(wsRes.status).toBe(201);

    await request(app).delete(`/api/organizations/${orgId}/members/${member.userId}`).set(authHeader(admin.accessToken));

    const wsMembership = await db('workspace_members').where({ workspace_id: wsRes.body.id, user_id: member.userId }).first();
    expect(wsMembership).toBeDefined();
    expect(wsMembership.system_role).toBe('OWNER');
  });

  // FEATURE_REQUEST.md entry 1's locked-in decision: no "≥1 admin"
  // invariant for orgs, unlike the workspace OWNER guarantee.
  test('removing the last ORG_ADMIN succeeds — no invariant blocks it', async () => {
    const admin = await seedSystemAdmin('orglastadmin0');
    const orgRes = await createOrg(admin, 'Org Last Admin Test');
    const orgId = orgRes.body.id;

    // admin removes themself as the sole ORG_ADMIN.
    const res = await request(app)
      .delete(`/api/organizations/${orgId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(204);

    const remaining = await db('organization_members').where({ organization_id: orgId });
    expect(remaining).toHaveLength(0);
  });
});
