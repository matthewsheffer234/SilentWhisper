import { jest } from '@jest/globals';
import knexFactory from 'knex';
import 'dotenv/config';
import {
  appendAuditEvent,
  appendAuditEventOrEnqueueRetry,
  computeRowHash,
  GENESIS_HASH,
} from '../src/audit/auditService.js';

// These tests run against a real Postgres (see RUNBOOK.md — bring up the
// `postgres` service via docker compose and run migrations first). The audit
// hash chain's correctness guarantee is a Postgres advisory lock, so a real
// database is the point, not something to mock away.
//
// `db` connects as the least-privilege app_runtime_user role — the same
// connection the running app would use — so these tests also prove the
// append-only grant actually holds. Because that role deliberately has no
// UPDATE/DELETE/TRUNCATE on audit_logs (Section 5), a second `adminDb`
// connection (PG* superuser credentials) exists purely to clear the table
// between tests; it is never used to exercise audit behavior itself.
const db = knexFactory({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.APP_DB_USER,
    password: process.env.APP_DB_PASSWORD,
    database: process.env.PGDATABASE,
  },
  pool: { min: 1, max: 10 },
});

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

beforeEach(async () => {
  await adminDb('audit_logs').del();
  // app_runtime_user has full CRUD on audit_retry_outbox (unlike audit_logs
  // itself) — no adminDb needed to clear it between tests.
  await db('audit_retry_outbox').del();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db.destroy();
  await adminDb.destroy();
});

test('the first audit row chains from the genesis hash', async () => {
  const row = await appendAuditEvent(db, {
    actorId: '00000000-0000-0000-0000-000000000001',
    actorIp: '127.0.0.1',
    actionType: 'AUTH_LOGIN',
    payload: { username: 'alice' },
  });

  expect(row.prev_row_hash).toBe(GENESIS_HASH);
  expect(row.curr_row_hash).toBe(
    computeRowHash({
      prevRowHash: GENESIS_HASH,
      actorId: '00000000-0000-0000-0000-000000000001',
      actorIp: '127.0.0.1',
      actionType: 'AUTH_LOGIN',
      targetResource: undefined,
      payload: { username: 'alice' },
    }),
  );
});

test('sequential rows form a verifiable linear chain', async () => {
  const first = await appendAuditEvent(db, {
    actorId: '00000000-0000-0000-0000-000000000001',
    actorIp: '127.0.0.1',
    actionType: 'AUTH_LOGIN',
  });
  const second = await appendAuditEvent(db, {
    actorId: '00000000-0000-0000-0000-000000000001',
    actorIp: '127.0.0.1',
    actionType: 'AUTH_LOGIN_FAILURE',
  });

  expect(second.prev_row_hash).toBe(first.curr_row_hash);

  const rows = await db('audit_logs').select('*').orderBy('id', 'asc');
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    expect(row.prev_row_hash).toBe(expectedPrev);
    const recomputed = computeRowHash({
      prevRowHash: row.prev_row_hash,
      actorId: row.actor_id,
      actorIp: row.actor_ip,
      actionType: row.action_type,
      targetResource: row.target_resource,
      payload: row.payload,
    });
    expect(row.curr_row_hash).toBe(recomputed);
    expectedPrev = row.curr_row_hash;
  }
});

test('concurrent inserts from the same process do not fork the chain', async () => {
  const concurrentEvents = Array.from({ length: 20 }, (_, i) => ({
    actorId: '00000000-0000-0000-0000-000000000001',
    actorIp: '127.0.0.1',
    actionType: 'AI_SUMMARIZE_REQUEST',
    targetResource: `channel-${i}`,
  }));

  // Simulates the realistic hazard from PROJECT_PLAN.md Section 3 (Audit
  // Log Write Serialization): many requests hitting the single Node process
  // at once, each trying to read "the latest row" and append after it. The
  // advisory lock, not this test's await ordering, is what keeps this safe.
  await Promise.all(concurrentEvents.map((event) => appendAuditEvent(db, event)));

  const rows = await db('audit_logs').select('*').orderBy('id', 'asc');
  expect(rows).toHaveLength(20);

  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    expect(row.prev_row_hash).toBe(expectedPrev);
    expectedPrev = row.curr_row_hash;
  }
});

test('appendAuditEvent rejects events missing required fields', async () => {
  await expect(
    appendAuditEvent(db, { actorIp: '127.0.0.1', actionType: 'AUTH_LOGIN' }),
  ).rejects.toThrow(/actorId/);
});

test('the runtime role cannot update or delete existing audit rows', async () => {
  const row = await appendAuditEvent(db, {
    actorId: '00000000-0000-0000-0000-000000000001',
    actorIp: '127.0.0.1',
    actionType: 'AUTH_LOGIN',
  });

  await expect(
    db('audit_logs').where({ id: row.id }).update({ action_type: 'TAMPERED' }),
  ).rejects.toThrow(/permission denied/i);

  await expect(db('audit_logs').where({ id: row.id }).del()).rejects.toThrow(/permission denied/i);
});

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #7 (SEC-03/
// GOV-03).
describe('appendAuditEventOrEnqueueRetry', () => {
  test('on success, behaves exactly like appendAuditEvent and enqueues nothing', async () => {
    const row = await appendAuditEventOrEnqueueRetry(db, {
      actorId: '00000000-0000-0000-0000-000000000002',
      actorIp: '127.0.0.1',
      actionType: 'AI_SUMMARIZE_REQUESTED',
    });

    expect(row.action_type).toBe('AI_SUMMARIZE_REQUESTED');
    const outboxRows = await db('audit_retry_outbox').select('*');
    expect(outboxRows).toHaveLength(0);
  });

  test('on a write failure, falls back to the outbox and still rethrows the original error', async () => {
    const event = {
      actorId: '00000000-0000-0000-0000-000000000003',
      actorIp: '127.0.0.1',
      actionType: 'AI_SUMMARIZE_REQUESTED',
      targetResource: 'some-channel-id',
      payload: { provider: 'ollama', promptVersion: 'v1' },
    };
    // Simulates a transient failure inside appendAuditEvent's transaction
    // (e.g. a dropped connection) — the specific cause doesn't matter here,
    // only that appendAuditEvent throws and this wrapper reacts correctly.
    // Not jest.spyOn(db, 'transaction'): knex's own `.transaction` is a
    // read-only property on the callable knex object, so a thin wrapper
    // that forwards every call except .transaction is used instead —
    // enqueueAuditRetry's own `db('audit_retry_outbox').insert(...)` call
    // still goes straight through to the real db either way.
    const failure = new Error('simulated transient DB failure');
    const dbWithFailingTransaction = Object.assign((...args) => db(...args), { transaction: () => Promise.reject(failure) });

    await expect(appendAuditEventOrEnqueueRetry(dbWithFailingTransaction, event)).rejects.toThrow(
      'simulated transient DB failure',
    );

    const outboxRow = await db('audit_retry_outbox').where({ actor_id: event.actorId }).first();
    expect(outboxRow).toBeDefined();
    expect(outboxRow.action_type).toBe('AI_SUMMARIZE_REQUESTED');
    expect(outboxRow.target_resource).toBe('some-channel-id');
    expect(outboxRow.payload).toEqual({ provider: 'ollama', promptVersion: 'v1' });
    expect(outboxRow.status).toBe('pending');

    // No row actually landed in audit_logs — the write genuinely failed.
    const auditRows = await db('audit_logs').select('*');
    expect(auditRows).toHaveLength(0);
  });

  test('when the fallback enqueue also fails (an invalid event), still rethrows the original error and leaves no outbox row', async () => {
    // Missing actorId fails appendAuditEvent's own upfront validation (a
    // real error path, not mocked) — and audit_retry_outbox.actor_id is
    // NOT NULL, so enqueueAuditRetry's own insert fails too for the exact
    // same reason. A genuinely invalid event must not silently disappear
    // into a row nobody can ever replay.
    await expect(
      appendAuditEventOrEnqueueRetry(db, { actorIp: '127.0.0.1', actionType: 'AUTH_LOGIN' }),
    ).rejects.toThrow(/actorId/);

    const outboxRows = await db('audit_retry_outbox').select('*');
    expect(outboxRows).toHaveLength(0);
  });
});
