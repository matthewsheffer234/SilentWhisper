// PROJECT_PLAN.md Section 4, "Layout And Structural Hierarchy".
// channels.type supports PUBLIC, PRIVATE, DIRECT, GROUP_DM (enforced at the
// application layer per Section 3, Input Handling & Injection Prevention).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE workspaces (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        owner_id UUID REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE channels (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(20) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE channel_members (
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (channel_id, user_id)
    )
  `);

  await knex.raw('CREATE INDEX idx_channel_members_user ON channel_members(user_id)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS channel_members');
  await knex.raw('DROP TABLE IF EXISTS channels');
  await knex.raw('DROP TABLE IF EXISTS workspaces CASCADE');
}
