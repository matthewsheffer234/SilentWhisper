// PROJECT_PLAN.md Section 4, "Communication And Content".
// Messages with parent_message_id IS NULL belong to the main channel feed;
// messages with parent_message_id set belong to a thread on that message.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id),
        content TEXT NOT NULL,
        parent_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw('CREATE INDEX idx_messages_channel_date ON messages(channel_id, created_at DESC)');
  await knex.raw(`
    CREATE INDEX idx_messages_threading ON messages(parent_message_id)
        WHERE parent_message_id IS NOT NULL
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS messages');
}
