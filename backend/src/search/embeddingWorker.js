import { config } from '../config.js';
import { embedText, toVectorLiteral } from './embeddingService.js';
import { computeSentimentScore } from './sentimentService.js';

// Async, failure-tolerant ingestion (FEATURE_REQUEST.md entry 1): polls the
// embedding_jobs queue table on a timer, same setInterval-sweep shape as
// llm/healthCheck.js / ws/presence.js. Single-instance basis (PROJECT_PLAN.md
// Section 2, Scalability Target) like those sweeps — the `running` guard
// below prevents a slow tick from overlapping itself in-process, and
// `FOR UPDATE SKIP LOCKED` in the claim query makes the claim itself correct
// even if this ever ran from more than one process.
let running = false;
let sweepTimer = null;
let status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };

// A CTE, not `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` —
// that form is a well-known Postgres trap: an uncorrelated IN-subquery is
// free to be planned as a semi-join whose inner side can be evaluated more
// than once per statement, and with tied ORDER BY values (e.g. several jobs
// enqueued in the same batch, sharing one created_at from a single now()
// call) each re-evaluation can pick a *different* arbitrary N-of-many
// subset — the whole UPDATE then ends up touching more than `batchSize`
// rows. Confirmed directly against a real table with tied timestamps:
// the IN-subquery form claimed all 5 pending rows instead of 3; this CTE
// form claimed exactly 3 every time across repeated runs. A data-modifying
// CTE (or one containing FOR UPDATE) is never inlined by Postgres's
// planner, so it's guaranteed to execute exactly once.
async function claimBatch(db, batchSize) {
  const result = await db.raw(
    `WITH claimed AS (
       SELECT message_id FROM embedding_jobs
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     UPDATE embedding_jobs eq
     SET status = 'processing', updated_at = now()
     FROM claimed
     WHERE eq.message_id = claimed.message_id
     RETURNING eq.message_id, eq.attempts`,
    [batchSize],
  );
  return result.rows;
}

async function processJob(db, job) {
  const message = await db('messages').where({ id: job.message_id }).first('content');
  if (!message) {
    // No message-deletion feature exists in this app today, so this
    // shouldn't happen in practice — guards against a future one leaving an
    // orphaned job row behind instead of silently retrying forever.
    await db('embedding_jobs').where({ message_id: job.message_id }).del();
    return;
  }

  try {
    const embedding = await embedText(db, message.content);
    // Sentiment scoring (FEATURE_REQUEST.md's "aggregate semantic/sentiment
    // trend" entry) reuses this same embedding — never a second
    // embedText() call for the message itself, only for the anchor phrases
    // the first time any message is ever processed (sentimentService.js's
    // own module-level cache).
    const sentimentScore = await computeSentimentScore(db, embedding);
    await db.transaction(async (trx) => {
      await trx('message_embeddings')
        .insert({
          message_id: job.message_id,
          embedding: trx.raw('?::vector', [toVectorLiteral(embedding)]),
          model: config.embedding.model,
        })
        .onConflict('message_id')
        .merge(['embedding', 'model']);
      await trx('message_sentiment_scores')
        .insert({ message_id: job.message_id, score: sentimentScore, model: config.embedding.model })
        .onConflict('message_id')
        .merge(['score', 'model']);
      await trx('embedding_jobs').where({ message_id: job.message_id }).del();
    });
    status.totalProcessed += 1;
  } catch (err) {
    status.totalFailed += 1;
    const attempts = job.attempts + 1;
    // Dead-lettered (status='failed', row kept for observability) once
    // attempts is exhausted; otherwise reset to 'pending' so the next tick
    // retries it — a simple fixed-interval retry, not exponential backoff,
    // which is an acceptable v1 given the worker's own poll interval already
    // spaces retries out.
    const nextStatus = attempts >= config.embedding.maxAttempts ? 'failed' : 'pending';
    // eslint-disable-next-line no-console
    console.error(`Embedding job for message ${job.message_id} failed (attempt ${attempts}):`, err.message || err);
    await db('embedding_jobs')
      .where({ message_id: job.message_id })
      .update({
        status: nextStatus,
        attempts,
        last_error: String(err.message || err).slice(0, 2000),
        updated_at: new Date(),
      });
  }
}

export async function runEmbeddingWorkerTick(db) {
  if (running) return;
  running = true;
  try {
    const jobs = await claimBatch(db, config.embedding.workerBatchSize);
    status = { ...status, lastRunAt: new Date().toISOString(), lastBatchSize: jobs.length };
    for (const job of jobs) {
      // Sequential, not Promise.all — each call to embedText already
      // contends for the shared embeddingConcurrencyGate, so processing the
      // batch sequentially keeps one slow/failing job from blocking the
      // whole in-process tick loop behind a burst of simultaneous requests
      // the gate would just reject anyway.
      // eslint-disable-next-line no-await-in-loop
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}

export function startEmbeddingWorker(db) {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    runEmbeddingWorkerTick(db).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Embedding worker tick failed:', err);
    });
  }, config.embedding.workerIntervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopEmbeddingWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function getEmbeddingWorkerStatus() {
  return status;
}

export function _resetForTests() {
  running = false;
  status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };
  stopEmbeddingWorker();
}
