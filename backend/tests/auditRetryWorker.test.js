import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { runAuditRetryWorkerTick, _resetForTests } from '../src/audit/auditRetryWorker.js';
import { GENESIS_HASH } from '../src/audit/auditService.js';

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #7 (SEC-03/
// GOV-03). Exercises runAuditRetryWorkerTick directly (not the auto-started
// interval — see index.js's NODE_ENV=test guard), the same convention
// embeddingWorker.test.js/messageSideEffectsWorker.test.js already
// established for their sibling workers. Outbox rows are inserted directly
// rather than through enqueueAuditRetry (already covered by
// auditService.test.js) — this file is about the worker's claim/replay/
// retry/dead-letter behavior, not the enqueue path.

beforeEach(async () => {
  await resetDb(db);
  _resetForTests();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function insertOutboxRow(overrides = {}) {
  const [row] = await db('audit_retry_outbox')
    .insert({
      actor_id: '00000000-0000-0000-0000-000000000001',
      actor_ip: '127.0.0.1',
      action_type: 'AI_SUMMARIZE_REQUESTED',
      target_resource: 'some-channel-id',
      payload: { provider: 'ollama' },
      ...overrides,
    })
    .returning('*');
  return row;
}

test('replays a pending outbox row into audit_logs, chained correctly, and deletes the outbox row', async () => {
  await insertOutboxRow();

  await runAuditRetryWorkerTick(db);

  const outboxRows = await db('audit_retry_outbox').select('*');
  expect(outboxRows).toHaveLength(0);

  const auditRow = await db('audit_logs').first();
  expect(auditRow).toBeDefined();
  expect(auditRow.action_type).toBe('AI_SUMMARIZE_REQUESTED');
  expect(auditRow.target_resource).toBe('some-channel-id');
  expect(auditRow.prev_row_hash).toBe(GENESIS_HASH);
});

test('replays multiple pending rows in order, appended onto the existing chain', async () => {
  await insertOutboxRow({ action_type: 'AI_SUMMARIZE_REQUESTED' });
  await insertOutboxRow({ action_type: 'AI_TASK_EXTRACTION_REQUESTED' });

  await runAuditRetryWorkerTick(db);

  const auditRows = await db('audit_logs').orderBy('id', 'asc');
  expect(auditRows).toHaveLength(2);
  expect(auditRows[1].prev_row_hash).toBe(auditRows[0].curr_row_hash);
});

test('a row that fails to replay is retried (pending, attempts incremented), not silently dropped', async () => {
  // Real outbox rows (via enqueueAuditRetry) always have a non-empty
  // actor_ip — an empty string here simulates a corrupted row deterministically
  // (appendAuditEvent's own validation rejects it, a real error path), the
  // same "intentionally unrecognized job_type" trick messageSideEffectsWorker
  // .test.js's own retry/dead-letter tests use.
  const row = await insertOutboxRow({ actor_ip: '' });

  await runAuditRetryWorkerTick(db);

  const after = await db('audit_retry_outbox').where({ id: row.id }).first();
  expect(after.status).toBe('pending');
  expect(after.attempts).toBe(1);
  expect(after.last_error).toMatch(/actorIp/);
  expect(await db('audit_logs').select('*')).toHaveLength(0);
});

test('dead-letters (status=failed) once AUDIT_RETRY_MAX_ATTEMPTS is exhausted, and stops consuming it after that', async () => {
  const row = await insertOutboxRow({ actor_ip: '' });

  for (let i = 0; i < config.audit.retryMaxAttempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runAuditRetryWorkerTick(db);
  }

  const after = await db('audit_retry_outbox').where({ id: row.id }).first();
  expect(after.status).toBe('failed');
  expect(after.attempts).toBe(config.audit.retryMaxAttempts);

  // One more tick must not touch it — 'failed' isn't claimed by the
  // pending-only claim query, so attempts must stay exactly at the cap.
  await runAuditRetryWorkerTick(db);
  const afterOneMore = await db('audit_retry_outbox').where({ id: row.id }).first();
  expect(afterOneMore.attempts).toBe(config.audit.retryMaxAttempts);
});

test('claims at most AUDIT_RETRY_WORKER_BATCH_SIZE pending rows per tick', async () => {
  for (let i = 0; i < config.audit.retryWorkerBatchSize + 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await insertOutboxRow({ target_resource: `resource-${i}` });
  }

  await runAuditRetryWorkerTick(db);

  const remaining = await db('audit_retry_outbox').count('* as count').first();
  expect(Number(remaining.count)).toBe(2);

  const replayed = await db('audit_logs').count('* as count').first();
  expect(Number(replayed.count)).toBe(config.audit.retryWorkerBatchSize);
});
