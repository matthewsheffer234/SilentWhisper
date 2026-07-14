import request from 'supertest';
import { app, start, shutdown } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

let server;

beforeAll(async () => {
  server = start(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  await shutdown(server);
  await destroyResetDbConnection();
});

beforeEach(async () => {
  await resetDb(db);
});

async function createWorkspace(owner, { name = 'W', visibility } = {}) {
  const res = await request(app)
    .post('/api/workspaces')
    .set(authHeader(owner.accessToken))
    .send(visibility ? { name, visibility } : { name });
  return res.body;
}

describe('POST /api/workspaces visibility', () => {
  test('defaults to PRIVATE when omitted', async () => {
    const owner = await signup(app, 'vizowner0');
    const ws = await createWorkspace(owner);
    expect(ws.visibility).toBe('PRIVATE');

    const row = await db('workspaces').where({ id: ws.id }).first('visibility');
    expect(row.visibility).toBe('PRIVATE');
  });

  test('persists an explicit DISCOVERABLE visibility', async () => {
    const owner = await signup(app, 'vizowner1');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });
    expect(ws.visibility).toBe('DISCOVERABLE');
  });

  test('rejects an invalid visibility value', async () => {
    const owner = await signup(app, 'vizowner2');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.accessToken))
      .send({ name: 'W', visibility: 'SECRET' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/workspaces/discoverable', () => {
  test('lists a DISCOVERABLE workspace the caller is not a member of', async () => {
    const owner = await signup(app, 'discowner0');
    const seeker = await signup(app, 'discseeker0');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });

    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(seeker.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.id)).toContain(ws.id);
    expect(res.body.find((w) => w.id === ws.id).role).toBeUndefined();
  });

  test('excludes a PRIVATE workspace', async () => {
    const owner = await signup(app, 'discowner1');
    const seeker = await signup(app, 'discseeker1');
    const ws = await createWorkspace(owner, { visibility: 'PRIVATE' });

    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(seeker.accessToken));
    expect(res.body.map((w) => w.id)).not.toContain(ws.id);
  });

  test('excludes a workspace the caller already belongs to', async () => {
    const owner = await signup(app, 'discowner2');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });

    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(owner.accessToken));
    expect(res.body.map((w) => w.id)).not.toContain(ws.id);
  });

  test('excludes an archived DISCOVERABLE workspace', async () => {
    const owner = await signup(app, 'discowner3');
    const seeker = await signup(app, 'discseeker3');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });
    await request(app).post(`/api/workspaces/${ws.id}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app).get('/api/workspaces/discoverable').set(authHeader(seeker.accessToken));
    expect(res.body.map((w) => w.id)).not.toContain(ws.id);
  });
});

describe('POST /api/workspaces/:workspaceId/subscribe', () => {
  test('succeeds on a DISCOVERABLE workspace and is idempotent-safe', async () => {
    const owner = await signup(app, 'subowner0');
    const joiner = await signup(app, 'subjoiner0');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });

    const first = await request(app).post(`/api/workspaces/${ws.id}/subscribe`).set(authHeader(joiner.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.role).toBe('MEMBER');

    const second = await request(app).post(`/api/workspaces/${ws.id}/subscribe`).set(authHeader(joiner.accessToken));
    expect(second.status).toBe(200);

    const memberRows = await db('workspace_members').where({ workspace_id: ws.id, user_id: joiner.userId });
    expect(memberRows.length).toBe(1);

    const auditRows = await db('audit_logs').where({ action_type: 'WORKSPACE_MEMBERSHIP_CHANGE', target_resource: ws.id });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].payload.action).toBe('subscribe');
  });

  test('a PRIVATE workspace 404s', async () => {
    const owner = await signup(app, 'subowner1');
    const joiner = await signup(app, 'subjoiner1');
    const ws = await createWorkspace(owner, { visibility: 'PRIVATE' });

    const res = await request(app).post(`/api/workspaces/${ws.id}/subscribe`).set(authHeader(joiner.accessToken));
    expect(res.status).toBe(404);
  });

  test('a nonexistent workspace 404s indistinguishably from a PRIVATE one', async () => {
    const joiner = await signup(app, 'subjoiner2');
    const res = await request(app)
      .post('/api/workspaces/00000000-0000-0000-0000-000000000000/subscribe')
      .set(authHeader(joiner.accessToken));
    expect(res.status).toBe(404);
  });

  test('an archived DISCOVERABLE workspace 409s', async () => {
    const owner = await signup(app, 'subowner3');
    const joiner = await signup(app, 'subjoiner3');
    const ws = await createWorkspace(owner, { visibility: 'DISCOVERABLE' });
    await request(app).post(`/api/workspaces/${ws.id}/archive`).set(authHeader(owner.accessToken));

    const res = await request(app).post(`/api/workspaces/${ws.id}/subscribe`).set(authHeader(joiner.accessToken));
    expect(res.status).toBe(409);
  });
});
