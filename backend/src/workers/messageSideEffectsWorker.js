import { config } from '../config.js';
import { extractMentionedUserIds } from '../services/mentionService.js';
import { createMentionNotifications } from '../services/mentionNotificationService.js';
import { linkMessageEntities } from '../services/entityService.js';
import { sendToUser } from '../ws/connectionRegistry.js';

// FEATURE_REQUEST.md "hot path splitting" entry: polls message_side_effect_jobs
// on a timer, same setInterval-sweep + FOR UPDATE SKIP LOCKED shape as
// search/embeddingWorker.js — that module is the template this one mirrors,
// not a new architecture. Single-instance basis (PROJECT_PLAN.md Section 2,
// Scalability Target) like every other sweep in this codebase; the `running`
// guard below prevents a slow tick from overlapping itself in-process, and
// FOR UPDATE SKIP LOCKED in the claim query makes the claim itself correct
// even if this ever ran from more than one process.
let running = false;
let sweepTimer = null;
let status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };

// Composite-key version of embeddingWorker.js's claimBatch — same reasoning
// for the CTE form over a `WHERE (message_id, job_type) IN (SELECT ...)`
// subquery (that form risks claiming more than batchSize rows when several
// jobs share a created_at value, since Postgres is free to evaluate an
// uncorrelated IN-subquery more than once per statement). A data-modifying
// CTE is never inlined by the planner, so it executes exactly once.
async function claimBatch(db, batchSize) {
  const result = await db.raw(
    `WITH claimed AS (
       SELECT message_id, job_type FROM message_side_effect_jobs
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     UPDATE message_side_effect_jobs j
     SET status = 'processing', updated_at = now()
     FROM claimed
     WHERE j.message_id = claimed.message_id AND j.job_type = claimed.job_type
     RETURNING j.message_id, j.job_type, j.attempts`,
    [batchSize],
  );
  return result.rows;
}

// Everything a job needs beyond message_id is re-derived here — no payload
// columns on the queue table, same minimal shape as embedding_jobs.
async function loadMessageContext(db, messageId) {
  return db('messages as m')
    .join('users as u', 'u.id', 'm.user_id')
    .join('channels as c', 'c.id', 'm.channel_id')
    .where('m.id', messageId)
    .first(
      'm.id',
      'm.channel_id',
      'm.user_id',
      'm.content',
      'm.parent_message_id',
      'm.created_at',
      'u.username',
      'u.display_name',
      'c.workspace_id',
    );
}

function toMessageShape(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    content: row.content,
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at,
  };
}

// Moves the entire mention pipeline that used to run inline at message-send
// time: parse -> write mention_notifications -> push a real-time `mention`
// WS frame. The frame push moves here too, not just the DB write — splitting
// it (push synchronously, write async) would need the notification id to
// exist before the write does, which isn't possible, and would leave the two
// permanently out of sync for no benefit.
async function processNotificationJob(db, row) {
  const message = toMessageShape(row);
  const mentionedUserIds = await extractMentionedUserIds(db, {
    content: message.content,
    channelId: message.channelId,
    excludeUserId: message.userId,
  });
  const notificationRows = await createMentionNotifications(db, {
    mentionedUserIds,
    message,
    workspaceId: row.workspace_id,
    mentionedByUserId: message.userId,
  });
  const notificationIdsByRecipient = new Map(notificationRows.map((r) => [r.recipient_user_id, r.id]));
  for (const mentionedUserId of mentionedUserIds) {
    sendToUser(mentionedUserId, {
      type: 'mention',
      message,
      channelId: message.channelId,
      workspaceId: row.workspace_id,
      mentionedBy: message.username,
      mentionedByDisplayName: message.displayName,
      notificationId: notificationIdsByRecipient.get(mentionedUserId) ?? null,
    });
  }
}

async function processEntityLinkJob(db, row) {
  // Enqueue time already gates this on workspaceId being truthy
  // (services/messageSideEffectsQueue.js) — this is defense in depth, not
  // the primary guard.
  if (!row.workspace_id) return;
  await linkMessageEntities(db, {
    content: row.content,
    messageId: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.user_id,
  });
}

async function processJob(db, job) {
  const row = await loadMessageContext(db, job.message_id);
  if (!row) {
    // No message-deletion feature exists in this app today, so this
    // shouldn't happen in practice — guards against a future one leaving an
    // orphaned job row behind instead of silently retrying forever. Same
    // handling as embeddingWorker.js's identical guard.
    await db('message_side_effect_jobs').where({ message_id: job.message_id, job_type: job.job_type }).del();
    return;
  }

  try {
    if (job.job_type === 'NOTIFICATION') {
      await processNotificationJob(db, row);
    } else if (job.job_type === 'ENTITY_LINK') {
      await processEntityLinkJob(db, row);
    } else {
      // Defensive: no code path inserts any other job_type today
      // (services/messageSideEffectsQueue.js only ever writes NOTIFICATION/
      // ENTITY_LINK) — this exists so a future bad insert dead-letters
      // loudly instead of silently looping forever as "processing" then
      // "pending" with nothing ever actually happening.
      throw new Error(`Unknown job_type: ${job.job_type}`);
    }
    await db('message_side_effect_jobs').where({ message_id: job.message_id, job_type: job.job_type }).del();
    status.totalProcessed += 1;
  } catch (err) {
    status.totalFailed += 1;
    const attempts = job.attempts + 1;
    // Same fixed-interval retry / dead-letter convention as
    // embeddingWorker.js: dead-lettered (status='failed', row kept for
    // observability) once attempts is exhausted, otherwise reset to
    // 'pending' so the next tick retries it.
    const nextStatus = attempts >= config.messageSideEffects.maxAttempts ? 'failed' : 'pending';
    // eslint-disable-next-line no-console
    console.error(
      `Message side-effect job (${job.job_type}) for message ${job.message_id} failed (attempt ${attempts}):`,
      err.message || err,
    );
    await db('message_side_effect_jobs')
      .where({ message_id: job.message_id, job_type: job.job_type })
      .update({
        status: nextStatus,
        attempts,
        last_error: String(err.message || err).slice(0, 2000),
        updated_at: new Date(),
      });
  }
}

export async function runMessageSideEffectsWorkerTick(db) {
  if (running) return;
  running = true;
  try {
    const jobs = await claimBatch(db, config.messageSideEffects.workerBatchSize);
    status = { ...status, lastRunAt: new Date().toISOString(), lastBatchSize: jobs.length };
    for (const job of jobs) {
      // Sequential, not Promise.all — mirrors embeddingWorker.js's own
      // reasoning: keeps one slow/failing job from letting the whole tick's
      // batch run unbounded in parallel against the DB and WS registry.
      // eslint-disable-next-line no-await-in-loop
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}

export function startMessageSideEffectsWorker(db) {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    runMessageSideEffectsWorkerTick(db).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Message side-effects worker tick failed:', err);
    });
  }, config.messageSideEffects.workerIntervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopMessageSideEffectsWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function getMessageSideEffectsWorkerStatus() {
  return status;
}

export function _resetForTests() {
  running = false;
  status = { lastRunAt: null, lastBatchSize: 0, totalProcessed: 0, totalFailed: 0 };
  stopMessageSideEffectsWorker();
}
