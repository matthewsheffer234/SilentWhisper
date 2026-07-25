// docs/reviews/2026-07-25-consolidated-meta-review.md finding #7 (SEC-03/
// GOV-03): runStreamingCompletion's onBeforeEnd calls appendAuditEvent
// (audit/auditService.js) after body bytes may already be on the wire, so a
// transient DB failure there can't be retried inline — the response has to
// complete regardless. Previously that failure was only logged, leaving a
// successful AI operation with no audit row. This table is a small,
// best-effort working queue (not the permanent audit trail itself — that
// stays audit_logs, append-only, hash-chained, no UPDATE/DELETE grant ever):
// one row per audit event that failed to write on the first attempt, claimed
// and replayed by audit/auditRetryWorker.js through the real
// appendAuditEvent, same claim/retry/dead-letter shape as embedding_jobs and
// message_side_effect_jobs. A row that succeeds on replay is deleted (no
// output-table ambiguity here, unlike message_side_effect_jobs — this table
// only ever holds events that are *known* to still need writing).
//
// Additive only, per CHANGELOG.md's MINOR-release rule: a new table, nothing
// existing changes shape.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw(`
    CREATE TABLE audit_retry_outbox (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        actor_id UUID NOT NULL,
        actor_ip VARCHAR(45) NOT NULL,
        action_type VARCHAR(100) NOT NULL,
        target_resource VARCHAR(255),
        payload JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw('CREATE INDEX idx_audit_retry_outbox_status ON audit_retry_outbox(status, created_at)');

  // Full CRUD, unlike audit_logs — this is a working queue table the same
  // shape as embedding_jobs/message_side_effect_jobs, not the immutable
  // audit trail (Section 5, Database Access Rights).
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON audit_retry_outbox TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw('REVOKE ALL PRIVILEGES ON audit_retry_outbox FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS audit_retry_outbox');
}
