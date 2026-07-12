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
