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
    const rows = [{ message_id: messageId, job_type: 'NOTIFICATION' }];
    // Entity linking is workspace-scoped (entities.workspace_id is NOT
    // NULL) — DIRECT/GROUP_DM channels have a NULL workspace_id and never
    // had an ENTITY_LINK job to do, the same gate the old inline call sites
    // applied before calling linkMessageEntities directly.
    if (workspaceId) {
      rows.push({ message_id: messageId, job_type: 'ENTITY_LINK' });
    }
    await db('message_side_effect_jobs').insert(rows).onConflict(['message_id', 'job_type']).ignore();
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
