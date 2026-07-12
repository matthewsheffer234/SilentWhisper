// PROJECT_PLAN.md Section 4, "Forensic Security Audit Log". Append-only —
// see 0007_grants.js for the REVOKE UPDATE/DELETE/TRUNCATE that enforces
// this at the database level, not just in application code.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE audit_logs (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        actor_id UUID NOT NULL,
        actor_ip VARCHAR(45) NOT NULL,
        action_type VARCHAR(100) NOT NULL,
        target_resource VARCHAR(255),
        payload JSONB,
        prev_row_hash VARCHAR(64) NOT NULL,
        curr_row_hash VARCHAR(64) NOT NULL
    )
  `);

  await knex.raw('CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC)');
  await knex.raw('CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS audit_logs');
}
