// FEATURE_REQUEST.md entry 3: the workspace task dashboard's
// `LIKE '%- [ ]%'`-shaped candidate scan over messages.content (see
// backend/src/routes/tasks.js) needs an index-assisted path within its own
// rolling window (TASK_DASHBOARD_WINDOW_DAYS) rather than a sequential scan,
// even at moderate history sizes — the same instinct as migration 0019's
// idx_entities_workspace_normalized_trgm. pg_trgm itself was already enabled
// by 0019, so this migration only adds the index; no new extension, no new
// grants (UPDATE on messages was already granted in 0007_grants.js, and this
// route is read-only).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw('CREATE INDEX idx_messages_content_trgm ON messages USING GIN (content gin_trgm_ops)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_messages_content_trgm');
}
