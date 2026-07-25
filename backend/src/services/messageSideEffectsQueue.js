// FEATURE_REQUEST.md "hot path splitting" entry: message send (both
// routes/messages.js and ws/server.js's handleMessage) used to call
// mention-notification-writing and entity-linking inline, in the same
// request/socket-message cycle as the message insert and room broadcast.
// Both call sites now enqueue durable job rows here instead — processed
// later by workers/messageSideEffectsWorker.js — so message-send latency no
// longer grows with mention count or entity count. Same
// "queue-insert failure must never fail the message-send response that
// already succeeded" contract as search/embeddingQueue.js's
// enqueueEmbeddingJob, which this deliberately mirrors.
export async function enqueueMessageSideEffectJobs(db, { messageId, workspaceId }) {
  try {
    const jobTypes = ['NOTIFICATION'];
    // Entity linking is workspace-scoped (entities.workspace_id is NOT
    // NULL) — DIRECT/GROUP_DM channels have a NULL workspace_id and never
    // had an ENTITY_LINK job to do, the same gate the old inline call sites
    // applied before calling linkMessageEntities directly.
    if (workspaceId) {
      jobTypes.push('ENTITY_LINK');
    }
    // routes/messages.js's PATCH (edit) route calls this a second time for
    // the same message_id once content actually changes, expecting the job
    // to run again against the new content. Since
    // workers/messageSideEffectsWorker.js now marks a finished row
    // status='completed' instead of deleting it (docs/reviews/
    // 2026-07-25-consolidated-meta-review.md finding #6), a plain
    // ON CONFLICT DO NOTHING insert would silently no-op against that
    // already-completed row and the edit's re-enqueue would never actually
    // re-run anything — this raw upsert conditionally resets the row to
    // 'pending' only when it's in a terminal state (completed or
    // dead-lettered failed); a row still pending/processing is left
    // completely untouched (the WHERE clause makes DO UPDATE a no-op, not
    // just a same-value overwrite), since it will already read the
    // message's latest content when it runs.
    for (const jobType of jobTypes) {
      // eslint-disable-next-line no-await-in-loop
      await db.raw(
        `INSERT INTO message_side_effect_jobs (message_id, job_type)
         VALUES (?, ?)
         ON CONFLICT (message_id, job_type) DO UPDATE
         SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
         WHERE message_side_effect_jobs.status IN ('completed', 'failed')`,
        [messageId, jobType],
      );
    }
  } catch (err) {
    // A queue-insert failure must never fail the message-send response that
    // already succeeded — the message itself is safely committed either
    // way, it just won't get mention notifications or entity links until
    // whenever this is retried (there is currently no retry-the-enqueue-
    // itself path — same accepted rare-gap tradeoff enqueueEmbeddingJob
    // documents for the identical situation).
    // eslint-disable-next-line no-console
    console.error(`Failed to enqueue message side-effect jobs for message ${messageId}:`, err);
  }
}

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #6 (GOV-02/
// EFF-03): the "no retry-the-enqueue-itself path" gap the comment above
// documents. workers/messageSideEffectsWorker.js calls this periodically to
// backfill the rare case where the insert above actually failed.
//
// Unlike embeddingQueue.js's counterpart, this can't check an output table
// for "already done" — a message can legitimately finish processing with
// zero mentions and zero linked entities, producing no mention_notifications
// or message_entities rows either way, so absence there proves nothing.
// What makes this safe instead: workers/messageSideEffectsWorker.js marks a
// completed job row status='completed' rather than deleting it, so a
// message_side_effect_jobs row's mere existence (any status) already means
// "this was enqueued at some point" — "no row at all for this
// (message_id, job_type)" is therefore an unambiguous "never enqueued"
// signal on its own, with no message-age window needed.
//
// Two separate INSERT...SELECT passes, not one: job_type is part of the
// anti-join condition (a message can correctly have a NOTIFICATION row and
// no ENTITY_LINK row, e.g. a DM), so a single query joined on message_id
// alone would incorrectly treat "missing just one of the two types" as
// "missing both."
export async function enqueueMissingMessageSideEffectJobs(db) {
  await db('message_side_effect_jobs')
    .insert(function missingNotificationJobs() {
      this.select(db.raw("m.id as message_id, 'NOTIFICATION' as job_type"))
        .from('messages as m')
        .leftJoin('message_side_effect_jobs as j', function joinNotificationJob() {
          this.on('j.message_id', '=', 'm.id').andOn('j.job_type', '=', db.raw('?', ['NOTIFICATION']));
        })
        .whereNull('j.message_id');
    })
    .onConflict(['message_id', 'job_type'])
    .ignore();

  // Entity linking is workspace-scoped, same gate enqueueMessageSideEffectJobs
  // applies above — a DIRECT/GROUP_DM message never gets one of these.
  await db('message_side_effect_jobs')
    .insert(function missingEntityLinkJobs() {
      this.select(db.raw("m.id as message_id, 'ENTITY_LINK' as job_type"))
        .from('messages as m')
        .join('channels as c', 'c.id', 'm.channel_id')
        .leftJoin('message_side_effect_jobs as j', function joinEntityLinkJob() {
          this.on('j.message_id', '=', 'm.id').andOn('j.job_type', '=', db.raw('?', ['ENTITY_LINK']));
        })
        .whereNotNull('c.workspace_id')
        .whereNull('j.message_id');
    })
    .onConflict(['message_id', 'job_type'])
    .ignore();
}
