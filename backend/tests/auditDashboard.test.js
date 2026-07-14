import knexFactory from 'knex';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { appendAuditEvent, verifyAuditChain } from '../src/audit/auditService.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// PROJECT_PLAN.md Section 8, Phase 5: the admin audit dashboard, and the
// verification logic it shares with the standalone /scripts CLI tool.

// Same admin/migration credentials pattern as auditService.test.js — used
// only to tamper a row directly for the "detects a broken chain" case,
// since app_runtime_user (what `db` connects as) deliberately has no
// UPDATE grant on audit_logs (Section 5).
const adminDb = knexFactory({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  },
  pool: { min: 1, max: 5 },
});

async function createWorkspace(user) {
  const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
  return res.body.id;
}

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await adminDb.destroy();
  await destroyResetDbConnection();
});

describe('verifyAuditChain', () => {
  test('reports verified on a clean chain', async () => {
    await appendAuditEvent(db, { actorId: '00000000-0000-0000-0000-000000000001', actorIp: '127.0.0.1', actionType: 'AUTH_LOGIN' });
    await appendAuditEvent(db, { actorId: '00000000-0000-0000-0000-000000000001', actorIp: '127.0.0.1', actionType: 'AUTH_LOGOUT' });

    const result = await verifyAuditChain(db);
    expect(result).toEqual({ verified: true, rowsChecked: 2 });
  });

  test('reports verified with zero rows', async () => {
    const result = await verifyAuditChain(db);
    expect(result).toEqual({ verified: true, rowsChecked: 0 });
  });

  test('detects tampering and reports the first broken row, not just "something is wrong"', async () => {
    await appendAuditEvent(db, { actorId: '00000000-0000-0000-0000-000000000001', actorIp: '127.0.0.1', actionType: 'AUTH_LOGIN' });
    const second = await appendAuditEvent(db, {
      actorId: '00000000-0000-0000-0000-000000000001',
      actorIp: '127.0.0.1',
      actionType: 'AUTH_LOGOUT',
    });
    await appendAuditEvent(db, { actorId: '00000000-0000-0000-0000-000000000001', actorIp: '127.0.0.1', actionType: 'AUTH_SIGNUP' });

    // Tamper the middle row's action_type without touching its stored hash —
    // exactly what an attacker with raw DB access (not through the app) would
    // have to do, since the app itself has no UPDATE path to audit_logs.
    await adminDb('audit_logs').where({ id: second.id }).update({ action_type: 'TAMPERED' });

    const result = await verifyAuditChain(db);
    expect(result.verified).toBe(false);
    expect(result.firstFailure.id).toBe(second.id);
    expect(result.rowsChecked).toBe(3);
  });
});

describe('GET /api/audit/logs', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/audit/logs');
    expect(res.status).toBe(401);
  });

  test('rejects a non-admin (workspace member but not OWNER/MANAGER of any workspace)', async () => {
    const admin = await signup(app, 'auditadmin0');
    const member = await signup(app, 'auditmember0');
    const workspaceId = await createWorkspace(admin);
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app).get('/api/audit/logs').set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('an OWNER sees existing audit events, newest first, and the access itself is audited', async () => {
    const admin = await signup(app, 'auditadmin1');
    // signup + creating a workspace already produced AUTH_SIGNUP and
    // WORKSPACE_CREATED audit rows.
    await createWorkspace(admin);

    const res = await request(app).get('/api/audit/logs').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // Newest first. audit_logs.id is BIGSERIAL — node-postgres returns int8
    // columns as strings (to avoid silent precision loss beyond 2^53), so
    // the JSON response's `id` is a string too; compare numerically here
    // rather than relying on string ordering (which happens to work for
    // same-length numbers but isn't actually what "newest first" means).
    for (let i = 1; i < res.body.length; i += 1) {
      expect(Number(res.body[i - 1].id)).toBeGreaterThan(Number(res.body[i].id));
    }

    const dashboardAccessRow = await db('audit_logs').where({ action_type: 'AUDIT_DASHBOARD_ACCESSED' }).first();
    expect(dashboardAccessRow).toBeDefined();
    expect(dashboardAccessRow.actor_id).toBe(admin.userId);
  });

  test('paginates with beforeId and respects limit', async () => {
    const admin = await signup(app, 'auditadmin2');
    await createWorkspace(admin);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await appendAuditEvent(db, { actorId: admin.userId, actorIp: '127.0.0.1', actionType: `EVENT_${i}` });
    }

    const firstPage = await request(app).get('/api/audit/logs?limit=2').set(authHeader(admin.accessToken));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toHaveLength(2);

    const oldestIdOnFirstPage = firstPage.body[firstPage.body.length - 1].id;
    const secondPage = await request(app)
      .get(`/api/audit/logs?limit=2&beforeId=${oldestIdOnFirstPage}`)
      .set(authHeader(admin.accessToken));
    expect(secondPage.status).toBe(200);
    secondPage.body.forEach((row) => expect(Number(row.id)).toBeLessThan(Number(oldestIdOnFirstPage)));
  });

  test('rejects an out-of-range limit', async () => {
    const admin = await signup(app, 'auditadmin3');
    await createWorkspace(admin);
    const res = await request(app).get('/api/audit/logs?limit=99999').set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/audit/verify', () => {
  test('rejects a non-admin', async () => {
    const member = await signup(app, 'auditmember1');
    const res = await request(app).post('/api/audit/verify').set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('an OWNER gets a verified result and it is audited as AUDIT_VERIFICATION_ATTEMPTED', async () => {
    const admin = await signup(app, 'auditadmin4');
    await createWorkspace(admin);

    const res = await request(app).post('/api/audit/verify').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);

    const verifyRow = await db('audit_logs').where({ action_type: 'AUDIT_VERIFICATION_ATTEMPTED' }).first();
    expect(verifyRow).toBeDefined();
    expect(verifyRow.actor_id).toBe(admin.userId);
    expect(verifyRow.payload).toMatchObject({ verified: true });
  });

  test('reports verified: false after a row is tampered with directly in the database', async () => {
    const admin = await signup(app, 'auditadmin5');
    await createWorkspace(admin);
    const row = await db('audit_logs').where({ action_type: 'AUTH_SIGNUP' }).first();
    await adminDb('audit_logs').where({ id: row.id }).update({ actor_ip: '9.9.9.9' });

    const res = await request(app).post('/api/audit/verify').set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.firstFailure.id).toBe(row.id);
  });
});
