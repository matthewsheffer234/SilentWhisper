import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1:
// requireSystemPermission grants access via two independent paths — an
// is_system_admin override, or the pre-existing "OWNER/MANAGER of at least
// one workspace" rule (the literal successor to the old
// requireAnyWorkspaceAdmin). Both paths need coverage, since a later slice
// removing the OR-fallback without checking this would be a real regression
// (see membershipService.js's own comment on requireSystemPermission).

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('requireSystemPermission: is_system_admin override', () => {
  test('a system admin with zero workspace memberships can read AI settings and the audit dashboard', async () => {
    const user = await seedSystemAdmin('sysadmin0');

    const aiRes = await request(app).get('/api/ai/settings').set(authHeader(user.accessToken));
    expect(aiRes.status).toBe(200);

    const auditRes = await request(app).get('/api/audit/logs').set(authHeader(user.accessToken));
    expect(auditRes.status).toBe(200);
  });

  test('the override is recorded on the audit trail as viaSystemAdminOverride: true', async () => {
    const user = await seedSystemAdmin('sysadmin1');

    await request(app).get('/api/audit/logs').set(authHeader(user.accessToken));

    const row = await db('audit_logs').where({ action_type: 'AUDIT_DASHBOARD_ACCESSED' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ viaSystemAdminOverride: true });
  });

  test('a non-admin, non-system-admin user still gets 403 on both surfaces', async () => {
    const user = await signup('plainuser0');

    const aiRes = await request(app).get('/api/ai/settings').set(authHeader(user.accessToken));
    expect(aiRes.status).toBe(403);

    const auditRes = await request(app).get('/api/audit/logs').set(authHeader(user.accessToken));
    expect(auditRes.status).toBe(403);
  });
});

describe('requireSystemPermission: OWNER/MANAGER-of-any-workspace fallback', () => {
  test('a MANAGER (not a system admin) can still hit AI settings and the audit dashboard', async () => {
    const owner = await signup('fallbackowner0');
    const manager = await signup('fallbackmanager0');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'fallbackmanager0', role: 'MANAGER' });

    const aiRes = await request(app).get('/api/ai/settings').set(authHeader(manager.accessToken));
    expect(aiRes.status).toBe(200);

    const auditRes = await request(app).get('/api/audit/logs').set(authHeader(manager.accessToken));
    expect(auditRes.status).toBe(200);

    const row = await db('audit_logs').where({ action_type: 'AUDIT_DASHBOARD_ACCESSED' }).orderBy('id', 'desc').first();
    expect(row.payload).toMatchObject({ viaSystemAdminOverride: false });
  });
});
