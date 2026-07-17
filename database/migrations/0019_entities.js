// FEATURE_REQUEST.md backlog items 2 and 3: workspace-scoped double-bracket
// entities and message reference links. Entity names are scoped to a
// workspace, never global, so unrelated organizations/workspaces can use the
// same noun without collision or disclosure.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');

  await knex.raw(`
    CREATE TABLE entities (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        canonical_name VARCHAR(255) NOT NULL,
        normalized_name VARCHAR(255) NOT NULL,
        aliases VARCHAR(255)[] NOT NULL DEFAULT '{}',
        description TEXT NULL,
        created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (workspace_id, normalized_name)
    )
  `);
  await knex.raw('CREATE INDEX idx_entities_workspace_normalized_trgm ON entities USING GIN (normalized_name gin_trgm_ops)');
  await knex.raw('CREATE INDEX idx_entities_workspace ON entities(workspace_id)');

  await knex.raw(`
    CREATE TABLE message_entities (
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, entity_id)
    )
  `);
  await knex.raw('CREATE INDEX idx_message_entities_entity ON message_entities(entity_id)');

  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO ??', [appDbUser]);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON message_entities TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON message_entities FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS message_entities');
  await knex.raw('REVOKE ALL PRIVILEGES ON entities FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS entities');
}
