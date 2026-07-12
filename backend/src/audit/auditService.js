import crypto from 'node:crypto';

// Fixed genesis previous-hash value for the first row ever inserted into
// audit_logs (PROJECT_PLAN.md Section 6, Immutable Local Auditing: "The
// first audit row uses a fixed genesis previous hash value documented in
// code."). 64 zero characters — same length as a SHA-256 hex digest, so the
// chain's shape is uniform from row 1 onward, but visually unmistakable as
// "no predecessor" rather than a real hash.
export const GENESIS_HASH = '0'.repeat(64);

// A single, fixed advisory-lock key for the audit hash chain. Any 64-bit
// integer works as long as it's stable and not reused for an unrelated lock
// elsewhere in the app. Chosen arbitrarily; do not change once rows exist,
// or concurrent writers before/after the change could race against each
// other during a deploy that straddles the change.
export const AUDIT_CHAIN_LOCK_KEY = 725_001_001;

// Recursively sort object keys so the same logical payload always serializes
// to the same JSON string, regardless of property insertion order — required
// for the hash chain to be reproducible by the verification script.
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function canonicalJSONStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function computeRowHash({ prevRowHash, actorId, actorIp, actionType, targetResource, payload }) {
  const canonicalPayload = canonicalJSONStringify({
    actorId,
    actorIp,
    actionType,
    targetResource: targetResource ?? null,
    payload: payload ?? null,
  });
  return crypto
    .createHash('sha256')
    .update(prevRowHash)
    .update(canonicalPayload)
    .digest('hex');
}

/**
 * The only application code path that may insert into audit_logs
 * (PROJECT_PLAN.md Section 6). Serializes the read-latest-hash-then-insert
 * step with a Postgres advisory lock so concurrent callers — from the same
 * process or, unlike an in-process mutex, from an overlapping deploy running
 * two processes briefly — can never read the same "latest row" and fork the
 * chain (Section 3, Audit Log Write Serialization).
 *
 * @param {import('knex').Knex} db
 * @param {{ actorId: string, actorIp: string, actionType: string, targetResource?: string, payload?: object }} event
 */
export async function appendAuditEvent(db, event) {
  const { actorId, actorIp, actionType, targetResource, payload } = event;
  if (!actorId || !actorIp || !actionType) {
    throw new Error('appendAuditEvent requires actorId, actorIp, and actionType');
  }

  return db.transaction(async (trx) => {
    // Held for the lifetime of this transaction. Any other transaction
    // (this process or another) trying to append an audit event blocks here
    // until this one commits or rolls back.
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [AUDIT_CHAIN_LOCK_KEY]);

    const lastRow = await trx('audit_logs')
      .select('curr_row_hash')
      .orderBy('id', 'desc')
      .first();

    const prevRowHash = lastRow ? lastRow.curr_row_hash : GENESIS_HASH;
    const currRowHash = computeRowHash({
      prevRowHash,
      actorId,
      actorIp,
      actionType,
      targetResource,
      payload,
    });

    const [inserted] = await trx('audit_logs')
      .insert({
        actor_id: actorId,
        actor_ip: actorIp,
        action_type: actionType,
        target_resource: targetResource ?? null,
        payload: payload ?? null,
        prev_row_hash: prevRowHash,
        curr_row_hash: currRowHash,
      })
      .returning('*');

    return inserted;
  });
}
