// FEATURE_REQUEST.md backlog entry 3, "Editing a sent message, with a
// permanent, auditable revision history". `messages.edited_at` (NULL =
// never edited) is how callers know a message was changed at all;
// message_edits is where the *content* history actually lives — one row
// per edit, holding the message's content exactly as it was immediately
// before that edit, so the very first row is the message as originally
// sent. `messages.content` always holds the current text.
//
// message_edits deliberately gets no UPDATE or DELETE grant, unlike every
// other application table (which at minimum keep UPDATE) — a historical
// snapshot must never change once written, not just resist deletion. This
// goes further than the existing no-hard-delete guarantee
// (noHardDelete.test.js: app_runtime_user cannot DELETE from
// users/workspaces/channels/messages) rather than merely matching it.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.schema.alterTable('messages', (table) => {
    table.timestamp('edited_at', { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE TABLE message_edits (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        edited_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        edited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw('CREATE INDEX idx_message_edits_message ON message_edits(message_id, edited_at DESC)');

  await knex.raw('GRANT SELECT, INSERT ON message_edits TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw('REVOKE ALL PRIVILEGES ON message_edits FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS message_edits');

  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('edited_at');
  });
}
