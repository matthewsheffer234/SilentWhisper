// PROJECT_PLAN.md Section 4, "Users And Security".

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE workspace_members (
        workspace_id UUID NOT NULL,
        user_id UUID NOT NULL,
        system_role VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
        PRIMARY KEY (workspace_id, user_id)
    )
  `);

  await knex.raw('CREATE INDEX idx_workspace_members_user ON workspace_members(user_id)');

  await knex.raw(`
    CREATE TABLE refresh_tokens (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        revoked_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw('CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id)');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS refresh_tokens');
  await knex.raw('DROP TABLE IF EXISTS workspace_members');
  await knex.raw('DROP TABLE IF EXISTS users CASCADE');
}
