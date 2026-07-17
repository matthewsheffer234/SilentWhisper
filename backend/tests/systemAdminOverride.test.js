import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// requireSystemAdmin (backend/src/authz/membershipService.js) gates the two
// global, non-workspace-scoped surfaces (AI settings, audit dashboard) on
// is_system_admin alone. It used to also grant access to any OWNER/MANAGER
// of at least one workspace — Security.md's 2026-07-15 HIGH finding
// ("Self-Service Workspace Ownership Grants Global Audit/AI
// Administration") flagged that as a self-escalation path, since any user
// can become OWNER just by creating a workspace. That fallback is now
// removed; the second describe block below covers the regression directly.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('requireSystemAdmin: is_system_admin gate', () => {
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

describe('requireSystemAdmin: the removed OWNER/MANAGER-of-any-workspace fallback', () => {
  test('a workspace OWNER (not a system admin) gets 403 on both surfaces, and self-escalation via workspace creation no longer works', async () => {
    const owner = await signup('fallbackowner0');
    await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const aiRes = await request(app).get('/api/ai/settings').set(authHeader(owner.accessToken));
    expect(aiRes.status).toBe(403);

    const auditRes = await request(app).get('/api/audit/logs').set(authHeader(owner.accessToken));
    expect(auditRes.status).toBe(403);
  });

  test('a MANAGER (not a system admin) also gets 403 on both surfaces', async () => {
    const owner = await signup('fallbackowner1');
    const manager = await signup('fallbackmanager1');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'fallbackmanager1', role: 'MANAGER' });

    const aiRes = await request(app).get('/api/ai/settings').set(authHeader(manager.accessToken));
    expect(aiRes.status).toBe(403);

    const auditRes = await request(app).get('/api/audit/logs').set(authHeader(manager.accessToken));
    expect(auditRes.status).toBe(403);
  });
});
