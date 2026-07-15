// Persistent mention notification display (FEATURE_REQUEST.md).
// One row per recipient per message, so a toast/browser notification can be
// backed by durable unread state without changing the messages table itself.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw(`
    CREATE TABLE mention_notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        mentioned_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        read_at TIMESTAMP WITH TIME ZONE,
        dismissed_at TIMESTAMP WITH TIME ZONE,
        UNIQUE (recipient_user_id, message_id)
    )
  `);

  await knex.raw(`
    CREATE INDEX idx_mention_notifications_recipient_unread_date
      ON mention_notifications(recipient_user_id, read_at, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX idx_mention_notifications_recipient_workspace_unread
      ON mention_notifications(recipient_user_id, workspace_id, read_at)
  `);
  await knex.raw('CREATE INDEX idx_mention_notifications_message ON mention_notifications(message_id)');
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON mention_notifications TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON mention_notifications FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS mention_notifications');
}
