import { config } from '../config.js';
import { appendAuditEvent } from './auditService.js';

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #7 (SEC-03/
// GOV-03). Polls audit_retry_outbox on a timer, same setInterval-sweep +
// FOR UPDATE SKIP LOCKED shape as search/embeddingWorker.js and
// workers/messageSideEffectsWorker.js — this is the third worker mirroring
// that same template, not a new architecture. Single-instance basis
// (PROJECT_PLAN.md Section 2, Scalability Target) like every other sweep in
// this codebase; the `running` guard below prevents a slow tick from
// overlapping itself in-process, and FOR UPDATE SKIP LOCKED in the claim
// query makes the claim itself correct even if this ever ran from more than
// one process.
let running = false;
let sweepTimer = null;
let status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };

// Same CTE-over-IN-subquery reasoning as the other two workers' claimBatch —
// a data-modifying CTE is never inlined by Postgres's planner, so it's
// guaranteed to execute exactly once and claim exactly batchSize rows even
// with tied created_at values.
async function claimBatch(db, batchSize) {
  const result = await db.raw(
    `WITH claimed AS (
       SELECT id FROM audit_retry_outbox
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     UPDATE audit_retry_outbox o
     SET status = 'processing', updated_at = now()
     FROM claimed
     WHERE o.id = claimed.id
     RETURNING o.id, o.actor_id, o.actor_ip, o.action_type, o.target_resource, o.payload, o.attempts`,
    [batchSize],
  );
  return result.rows;
}

async function processJob(db, job) {
  try {
    await appendAuditEvent(db, {
      actorId: job.actor_id,
      actorIp: job.actor_ip,
      actionType: job.action_type,
      targetResource: job.target_resource,
      payload: job.payload,
    });
    // Unlike message_side_effect_jobs, this row is deleted (not marked
    // 'completed') on success — audit_retry_outbox only ever holds events
    // known to still need writing, so there's no "was this ever enqueued"
    // ambiguity for a reconciliation pass to worry about; the real,
    // permanent record now lives in audit_logs.
    await db('audit_retry_outbox').where({ id: job.id }).del();
    status.totalProcessed += 1;
  } catch (err) {
    status.totalFailed += 1;
    const attempts = job.attempts + 1;
    // Same fixed-interval retry / dead-letter convention as the other two
    // workers: dead-lettered (status='failed', row kept for observability)
    // once attempts is exhausted, otherwise reset to 'pending' so the next
    // tick retries it.
    const nextStatus = attempts >= config.audit.retryMaxAttempts ? 'failed' : 'pending';
    // eslint-disable-next-line no-console
    console.error(`Audit retry for ${job.action_type} (outbox row ${job.id}) failed (attempt ${attempts}):`, err.message || err);
    await db('audit_retry_outbox')
      .where({ id: job.id })
      .update({
        status: nextStatus,
        attempts,
        last_error: String(err.message || err).slice(0, 2000),
        updated_at: new Date(),
      });
  }
}

export async function runAuditRetryWorkerTick(db) {
  if (running) return;
  running = true;
  try {
    const jobs = await claimBatch(db, config.audit.retryWorkerBatchSize);
    status = { ...status, lastRunAt: new Date().toISOString(), lastBatchSize: jobs.length };
    for (const job of jobs) {
      // Sequential, not Promise.all — mirrors the other two workers' own
      // reasoning: keeps one slow/failing retry from letting the whole
      // tick's batch run unbounded in parallel against the audit hash
      // chain's single advisory lock (auditService.js's appendAuditEvent),
      // which would just serialize on that lock anyway.
      // eslint-disable-next-line no-await-in-loop
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}

export function startAuditRetryWorker(db) {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    runAuditRetryWorkerTick(db).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Audit retry worker tick failed:', err);
    });
  }, config.audit.retryWorkerIntervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopAuditRetryWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function getAuditRetryWorkerStatus() {
  return status;
}

export function _resetForTests() {
  running = false;
  status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };
  stopAuditRetryWorker();
}
