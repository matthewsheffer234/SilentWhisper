// FEATURE_REQUEST.md "hot path splitting" entry, 2026-07-18. Same
// DB-backed-work-queue pattern as embedding_jobs (0009_pgvector_and_embeddings.js)
// — one row per (message, side-effect job type), claimed by a polling worker
// with FOR UPDATE SKIP LOCKED rather than a separate worker system. Two job
// types share this one table rather than getting their own tables each,
// since they're the same shape (retry/dead-letter over a message_id) and
// keeping them together means one worker, one poll loop, one place to look
// for queue depth.
//
// job_type is 'NOTIFICATION' | 'ENTITY_LINK', enforced at the application
// layer (services/messageSideEffectsQueue.js), not a Postgres enum — matches
// this schema's existing convention of VARCHAR + app-level assertEnum-style
// validation for status-like columns (e.g. channels.type, invitations.status)
// rather than a CREATE TYPE per enum.
//
// Deliberately no payload/context columns beyond message_id: everything the
// worker needs (message content, channel_id, workspace_id, sender identity)
// is re-derived by joining messages/channels/users at process time, the same
// minimal shape embedding_jobs already uses.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE message_side_effect_jobs (
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      job_type VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, job_type)
    )
  `);

  await knex.raw('CREATE INDEX idx_message_side_effect_jobs_status ON message_side_effect_jobs(status, created_at)');

  // Section 5, Database Access Rights: same GRANT set embedding_jobs got —
  // mirrors 0009's `??`-bound role-name pattern rather than hardcoding
  // "app_runtime_user" as a literal.
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON message_side_effect_jobs TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS message_side_effect_jobs');
}
