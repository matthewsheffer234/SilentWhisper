// FEATURE_REQUEST.md entry 5 (Admin Analytics Dashboard — activity and
// engagement metrics): GET /api/admin/analytics/activity aggregates
// messages ungrouped by channel_id (date_trunc(bucket, m.created_at) across
// every channel in scope), unlike every existing messages query in this app,
// which always filters/groups by a specific channel_id first. The existing
// idx_messages_channel_date (channel_id, created_at DESC) is built for
// exactly that per-channel access pattern and doesn't help a cross-channel
// scan with no channel_id equality filter — this is a genuinely new access
// pattern, not one the existing index happens to cover.
//
// GET /api/admin/analytics/dormant-channels also benefits: its per-channel
// LATERAL subquery (`ORDER BY created_at DESC LIMIT 1`, scoped by
// channel_id) is already covered by idx_messages_channel_date, but the
// windowDays predicate applied afterward scans created_at directly.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw('CREATE INDEX idx_messages_created_at ON messages(created_at)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_messages_created_at');
}
