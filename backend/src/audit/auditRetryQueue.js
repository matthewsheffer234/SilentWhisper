// docs/reviews/2026-07-25-consolidated-meta-review.md finding #7 (SEC-03/
// GOV-03). Sibling to search/embeddingQueue.js and
// services/messageSideEffectsQueue.js: a best-effort enqueue that must never
// throw past the caller (auditService.js's appendAuditEventOrEnqueueRetry is
// already deciding whether to call this from inside its own catch block —
// there is nothing left to fall back to if this insert itself fails beyond
// logging it).
export async function enqueueAuditRetry(db, { actorId, actorIp, actionType, targetResource, payload }) {
  try {
    await db('audit_retry_outbox').insert({
      actor_id: actorId,
      actor_ip: actorIp,
      action_type: actionType,
      target_resource: targetResource ?? null,
      payload: payload ?? null,
    });
  } catch (err) {
    // Both the original audit write AND the fallback enqueue failed — same
    // "rare, narrow, best-effort, log and move on" precedent as
    // enqueueEmbeddingJob/enqueueMessageSideEffectJobs. Nothing left to do
    // but make this loudly visible in logs for an operator to notice.
    // eslint-disable-next-line no-console
    console.error(`Failed to enqueue audit retry for ${actionType} (event will be lost):`, err.message || err);
  }
}
