// FEATURE_REQUEST.md entry 1: "when a message is committed through either
// REST or WebSocket, enqueue embedding work after the DB commit succeeds.
// This must be asynchronous and failure-tolerant: message send success
// cannot depend on the embedding provider being up." Called as a sibling
// step at both message-creation call sites (routes/messages.js,
// ws/server.js's handleMessage), immediately after the existing
// extractMentionedUserIds call — the same "side effect of message creation,
// not part of it" pattern already established there, not folded into
// services/messageService.js's createMessage itself.
export async function enqueueEmbeddingJob(db, messageId) {
  try {
    await db('embedding_jobs').insert({ message_id: messageId }).onConflict('message_id').ignore();
  } catch (err) {
    // A queue-insert failure must never fail the message-send response that
    // already succeeded — the message itself is safely committed either way,
    // it just won't be semantically searchable until whenever this is
    // retried (there is currently no retry-the-enqueue-itself path; a
    // message that never got a job row is a rare, logged gap, not a data-
    // loss risk, since the message itself is unaffected).
    // eslint-disable-next-line no-console
    console.error(`Failed to enqueue embedding job for message ${messageId}:`, err);
  }
}

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #6 (GOV-02/
// EFF-03): the "no retry-the-enqueue-itself path" gap the comment above
// documents. embeddingWorker.js calls this periodically (much less often
// than its own claim/process tick) to backfill the rare case where the
// insert above actually failed. A message needs embedding work if and only
// if it has neither an embedding_jobs row (still pending/processing/failed —
// the primary worker already owns that) nor a message_embeddings row
// (already done, and the job row was deleted on success) — this anti-join
// is therefore the correct, unambiguous "truly never enqueued" signal, no
// message-age window needed. Deliberately not scoped to a recent time
// window: the query is cheap in the overwhelmingly common case where the
// result set is empty (both LEFT JOINs resolve via each table's own primary
// key), and unlike message_side_effect_jobs below, there's no "was this
// already fully processed successfully" ambiguity to create a reprocessing
// loop — message_embeddings is a genuine, permanent completion signal.
export async function enqueueMissingEmbeddingJobs(db) {
  await db('embedding_jobs')
    .insert(function missingEmbeddings() {
      this.select('m.id as message_id')
        .from('messages as m')
        .leftJoin('embedding_jobs as ej', 'ej.message_id', 'm.id')
        .leftJoin('message_embeddings as me', 'me.message_id', 'm.id')
        .whereNull('ej.message_id')
        .whereNull('me.message_id');
    })
    .onConflict('message_id')
    .ignore();
}
