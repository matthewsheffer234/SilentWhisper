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
    expect(res.body.organizations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: orgRes.body.id, name: 'Org List Test', role: 'ORG_ADMIN' })]),
    );
    // The earliest-created default org (signup auto-enrollment) should also
    // be present, with ORG_MEMBER — confirming the join returns every org
    // this caller belongs to, not just the one just created.
    expect(res.body.organizations).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'ORG_MEMBER' })]));
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  test('a system admin sees every org, including ones they do not belong to', async () => {
    const admin = await seedSystemAdmin('orglist1');
    const orgRes = await createOrg(admin, 'Org List Test 2');

    const outsider = await seedSystemAdmin('orglistoutsider1');

    // organizations is deliberately never cleared between tests
    // (resetDb.js — the earliest-created row must survive across the whole
    // run for signup's own auto-enrollment), so the just-created org's
    // absolute position keeps drifting later as more tests accumulate more
    // rows. Ordered created_at asc, it's always the very last row, so
    // fetching by that computed offset (rather than assuming it fits in a
    // single default-sized page) proves "system admin sees every org"
    // without being coupled to how many orgs already existed.
    const totalRes = await request(app)
      .get('/api/organizations?limit=1&offset=0')
      .set(authHeader(outsider.accessToken));
    expect(totalRes.status).toBe(200);
    const { total } = totalRes.body;

    const lastPage = await request(app)
      .get(`/api/organizations?limit=1&offset=${total - 1}`)
      .set(authHeader(outsider.accessToken));
    expect(lastPage.status).toBe(200);
    expect(lastPage.body.organizations[0].id).toBe(orgRes.body.id);
  });

  test('rejects malformed pagination params consistently with the admin routes', async () => {
    const user = await signup('orglistpaging0');

    const badLimit = await request(app).get('/api/organizations?limit=0').set(authHeader(user.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app).get('/api/organizations?offset=-1').set(authHeader(user.accessToken));
    expect(badOffset.status).toBe(400);
  });

  test('returns a correctly bounded page via limit/offset', async () => {
    const admin = await seedSystemAdmin('orglistpaging1');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await createOrg(admin, `Org Paging ${i}`);
    }

    const page1 = await request(app).get('/api/organizations?limit=2&offset=0').set(authHeader(admin.accessToken));
    expect(page1.status).toBe(200);
    expect(page1.body.organizations).toHaveLength(2);

    const page2 = await request(app).get('/api/organizations?limit=2&offset=2').set(authHeader(admin.accessToken));
    expect(page2.status).toBe(200);
    expect(page2.body.organizations.length).toBeGreaterThanOrEqual(1);
    expect(page2.body.total).toBe(page1.body.total);

    const page1Ids = page1.body.organizations.map((o) => o.id);
    const page2Ids = page2.body.organizations.map((o) => o.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });
});

describe('org membership routes', () => {
  test('roster/add/role-change/remove work for an ORG_ADMIN, and existence-hiding applies', async () => {
    const admin = await seedSystemAdmin('orgmember0');
    const orgRes = await createOrg(admin, 'Org Membership Test');
    const orgId = orgRes.body.id;

    const target = await signup('orgmembertarget0', { displayName: 'Org Member Target' });
    const addRes = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgmembertarget0' });
    expect(addRes.status).toBe(201);
    expect(addRes.body).toMatchObject({ username: 'orgmembertarget0', role: 'ORG_MEMBER' });

    const rosterRes = await request(app).get(`/api/organizations/${orgId}/members`).set(authHeader(admin.accessToken));
    expect(rosterRes.status).toBe(200);
    // FEATURE_REQUEST.md's "display names as the primary identity" entry:
    // the org member roster table.
    expect(rosterRes.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: target.userId, displayName: 'Org Member Target', role: 'ORG_MEMBER' }),
      ]),
    );
    expect(rosterRes.body.limit).toBe(50);
    expect(rosterRes.body.offset).toBe(0);
    expect(rosterRes.body.total).toBeGreaterThanOrEqual(2);

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

  test('members roster rejects malformed pagination params and returns a bounded page', async () => {
    const admin = await seedSystemAdmin('orgmemberpaging0');
    const orgRes = await createOrg(admin, 'Org Member Paging Test');
    const orgId = orgRes.body.id;
    for (let i = 0; i < 3; i += 1) {
      const target = await signup(`orgmemberpagingtarget${i}`);
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/organizations/${orgId}/members`)
        .set(authHeader(admin.accessToken))
        .send({ username: target.username });
    }

    const badLimit = await request(app)
      .get(`/api/organizations/${orgId}/members?limit=0`)
      .set(authHeader(admin.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app)
      .get(`/api/organizations/${orgId}/members?offset=-1`)
      .set(authHeader(admin.accessToken));
    expect(badOffset.status).toBe(400);

    const page = await request(app)
      .get(`/api/organizations/${orgId}/members?limit=2&offset=0`)
      .set(authHeader(admin.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.members).toHaveLength(2);
    // admin (auto-enrolled ORG_ADMIN) + 3 added targets = 4 total.
    expect(page.body.total).toBe(4);
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

// FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"),
// Part 3: self-service — plain requireOrgMember, no ORG_MANAGE_MEMBERS
// needed to remove yourself.
describe('POST /api/organizations/:orgId/leave', () => {
  test('a plain ORG_MEMBER can leave, and it is audited', async () => {
    const admin = await seedSystemAdmin('orgleaveadmin0');
    const orgRes = await createOrg(admin, 'Org Leave Test');
    const orgId = orgRes.body.id;
    const member = await signup('orgleavemember0');
    await request(app).post(`/api/organizations/${orgId}/members`).set(authHeader(admin.accessToken)).send({ username: 'orgleavemember0' });

    const res = await request(app).post(`/api/organizations/${orgId}/leave`).set(authHeader(member.accessToken));
    expect(res.status).toBe(204);

    const membershipRow = await db('organization_members').where({ organization_id: orgId, user_id: member.userId }).first();
    expect(membershipRow).toBeUndefined();

    const row = await db('audit_logs').where({ action_type: 'ORGANIZATION_MEMBERSHIP_CHANGE' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ action: 'leave', targetUserId: member.userId, targetUsername: 'orgleavemember0' });
  });

  test('leaving does not cascade to workspace memberships', async () => {
    const admin = await seedSystemAdmin('orgleavecascade0');
    const orgRes = await createOrg(admin, 'Org Leave Cascade Test');
    const orgId = orgRes.body.id;
    const member = await signup('orgleavecascademember0');
    await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgleavecascademember0' });
    const wsRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(member.accessToken))
      .send({ name: 'Member Workspace', organizationId: orgId });

    await request(app).post(`/api/organizations/${orgId}/leave`).set(authHeader(member.accessToken));

    const wsMembership = await db('workspace_members').where({ workspace_id: wsRes.body.id, user_id: member.userId }).first();
    expect(wsMembership).toBeDefined();
  });

  test('the sole ORG_ADMIN leaving succeeds — no invariant blocks it', async () => {
    const admin = await seedSystemAdmin('orgleavelastadmin0');
    const orgRes = await createOrg(admin, 'Org Leave Last Admin Test');
    const orgId = orgRes.body.id;

    const res = await request(app).post(`/api/organizations/${orgId}/leave`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(204);

    const remaining = await db('organization_members').where({ organization_id: orgId });
    expect(remaining).toHaveLength(0);
  });

  test('a non-member gets 404', async () => {
    const admin = await seedSystemAdmin('orgleaveadmin1');
    const orgRes = await createOrg(admin, 'Org Leave Outsider Test');
    const orgId = orgRes.body.id;
    const outsider = await signup('orgleaveoutsider1');

    const res = await request(app).post(`/api/organizations/${orgId}/leave`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('an archived organization 409s', async () => {
    const admin = await seedSystemAdmin('orgleaveadmin2');
    const orgRes = await createOrg(admin, 'Org Leave Archived Test');
    const orgId = orgRes.body.id;
    const member = await signup('orgleavemember2');
    await request(app).post(`/api/organizations/${orgId}/members`).set(authHeader(admin.accessToken)).send({ username: 'orgleavemember2' });
    await request(app).post(`/api/organizations/${orgId}/archive`).set(authHeader(admin.accessToken));

    const res = await request(app).post(`/api/organizations/${orgId}/leave`).set(authHeader(member.accessToken));
    expect(res.status).toBe(409);
  });
});

// System Admin panel: manage organizations and existing users. Organization
// lifecycle (rename/archive/unarchive) stays system-admin-only, same as
// creation — never ORG_ADMIN-manageable.
describe('PATCH /api/organizations/:orgId', () => {
  test('a system admin can rename an organization', async () => {
    const admin = await seedSystemAdmin('orgrename0');
    const orgRes = await createOrg(admin, 'Old Name');

    const res = await request(app)
      .patch(`/api/organizations/${orgRes.body.id}`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: orgRes.body.id, name: 'New Name' });

    const row = await db('organizations').where({ id: orgRes.body.id }).first('name');
    expect(row.name).toBe('New Name');

    const auditRow = await db('audit_logs').where({ action_type: 'ORGANIZATION_RENAMED' }).first();
    expect(auditRow.payload).toMatchObject({ fromName: 'Old Name', toName: 'New Name' });
  });

  test('a nonexistent org 404s', async () => {
    const admin = await seedSystemAdmin('orgrename1');
    const res = await request(app)
      .patch('/api/organizations/00000000-0000-0000-0000-000000000000')
      .set(authHeader(admin.accessToken))
      .send({ name: 'New Name' });
    expect(res.status).toBe(404);
  });

  // Even an ORG_ADMIN of the org itself can't rename it — org lifecycle is
  // system-admin-only, never ORG_ADMIN-manageable.
  test('an ORG_ADMIN (not a system admin) gets 403', async () => {
    const admin = await seedSystemAdmin('orgrename2');
    const orgRes = await createOrg(admin, 'Org Rename 403 Test');

    const member = await signup('orgrenamemember2');
    await request(app)
      .post(`/api/organizations/${orgRes.body.id}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgrenamemember2', role: 'ORG_ADMIN' });

    const res = await request(app)
      .patch(`/api/organizations/${orgRes.body.id}`)
      .set(authHeader(member.accessToken))
      .send({ name: 'Another Name' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/organizations/:orgId/archive and /unarchive', () => {
  test('archiving is idempotent and audited; unarchiving reverses it', async () => {
    const admin = await seedSystemAdmin('orgarchive0');
    const orgRes = await createOrg(admin, 'Org Archive Test');
    const orgId = orgRes.body.id;

    const first = await request(app).post(`/api/organizations/${orgId}/archive`).set(authHeader(admin.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.archivedAt).toBeTruthy();

    const second = await request(app).post(`/api/organizations/${orgId}/archive`).set(authHeader(admin.accessToken));
    expect(second.status).toBe(200);

    const archiveRows = await db('audit_logs').where({ action_type: 'ORGANIZATION_ARCHIVE_STATUS_CHANGE' });
    expect(archiveRows).toHaveLength(1);

    const unarchive = await request(app).post(`/api/organizations/${orgId}/unarchive`).set(authHeader(admin.accessToken));
    expect(unarchive.status).toBe(200);
    expect(unarchive.body.archivedAt).toBeNull();

    const rows = await db('audit_logs').where({ action_type: 'ORGANIZATION_ARCHIVE_STATUS_CHANGE' }).orderBy('id', 'asc');
    expect(rows.map((r) => r.payload.action)).toEqual(['archive', 'unarchive']);
  });

  test('a nonexistent org 404s', async () => {
    const admin = await seedSystemAdmin('orgarchive1');
    const res = await request(app)
      .post('/api/organizations/00000000-0000-0000-0000-000000000000/archive')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a non-system-admin gets 403', async () => {
    const admin = await seedSystemAdmin('orgarchive2');
    const orgRes = await createOrg(admin, 'Org Archive 403 Test');
    const member = await signup('orgarchivemember2');
    await request(app)
      .post(`/api/organizations/${orgRes.body.id}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'orgarchivemember2', role: 'ORG_ADMIN' });

    const res = await request(app).post(`/api/organizations/${orgRes.body.id}/archive`).set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });
});

// Mirrors workspaceArchiving.test.js's own "every gated write path 409s"
// pattern, one level up.
describe('every gated write path 409s against an archived organization', () => {
  async function setupArchivedOrg(label) {
    const admin = await seedSystemAdmin(`archorg${label}admin`);
    const orgRes = await createOrg(admin, `Archived Org ${label}`);
    const orgId = orgRes.body.id;
    await request(app).post(`/api/organizations/${orgId}/archive`).set(authHeader(admin.accessToken));
    return { admin, orgId };
  }

  test('adding a member 409s', async () => {
    const { admin, orgId } = await setupArchivedOrg('add');
    await signup('archorgaddtarget');
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'archorgaddtarget' });
    expect(res.status).toBe(409);
  });

  test('creating an invitation 409s', async () => {
    const { admin, orgId } = await setupArchivedOrg('invite');
    const res = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({});
    expect(res.status).toBe(409);
  });

  test("changing a member's role 409s", async () => {
    const { admin, orgId } = await setupArchivedOrg('role');
    // System admin override still grants existence, so re-fetch a real
    // membership: the admin's own row, created at org-creation time.
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'ORG_MEMBER' });
    expect(res.status).toBe(409);
  });

  test('removing a member 409s', async () => {
    const { admin, orgId } = await setupArchivedOrg('remove');
    const res = await request(app)
      .delete(`/api/organizations/${orgId}/members/${admin.userId}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(409);
  });

  test('creating a workspace targeting the archived org via explicit organizationId 409s', async () => {
    const { admin, orgId } = await setupArchivedOrg('ws');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Should Fail', organizationId: orgId });
    expect(res.status).toBe(409);
  });

  test('rename and archive/unarchive themselves are NOT blocked by archived state', async () => {
    const { admin, orgId } = await setupArchivedOrg('selfmanage');
    const renameRes = await request(app)
      .patch(`/api/organizations/${orgId}`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'Renamed While Archived' });
    expect(renameRes.status).toBe(200);

    const unarchiveRes = await request(app).post(`/api/organizations/${orgId}/unarchive`).set(authHeader(admin.accessToken));
    expect(unarchiveRes.status).toBe(200);
  });
});
