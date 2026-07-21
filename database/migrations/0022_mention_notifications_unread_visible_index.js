// Finding 5, docs/reviews/security-performance-review-2026-07-20.md:
// getMentionSummary()'s hot "unread badge count" query (recipient_user_id +
// read_at IS NULL + dismissed_at IS NULL, joined against channel_members)
// runs on every login and after every live mention/invitation WS event, but
// migration 0016's idx_mention_notifications_recipient_unread_date doesn't
// cover dismissed_at — every call re-scans rows this predicate should be
// able to skip entirely. Additive only; the existing indexes stay (still
// used by listMentionNotifications' before-cursor pagination and the
// per-workspace lookup).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE INDEX idx_mention_notifications_recipient_unread_visible
      ON mention_notifications(recipient_user_id, read_at, dismissed_at, created_at DESC)
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_mention_notifications_recipient_unread_visible');
}
