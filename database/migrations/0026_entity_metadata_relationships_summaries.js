// FEATURE_REQUEST.md backlog entry 4, "Entity pages as a lightweight
// knowledge base" — the scope left over after entry 2 (Knowledge Explorer)
// covers trending/SME/citation-history: editable entity metadata
// (owner/steward, status, tags, an optional external/local reference URL),
// entity_relationships, and cached AI-generated "What we know" summaries.
//
// Additive only, per CHANGELOG.md's MINOR-release rule: new nullable/
// defaulted columns on the existing entities table, two new tables. No
// existing row's meaning changes.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw(`
    ALTER TABLE entities
      ADD COLUMN owner_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      ADD COLUMN tags VARCHAR(40)[] NOT NULL DEFAULT '{}',
      ADD COLUMN reference_url VARCHAR(500) NULL
  `);

  // workspace_id is denormalized from source_entity_id/target_entity_id's
  // own workspace_id (both entities are always required to share it, enforced
  // at the application layer in entities.js) so authorization/isolation
  // queries can filter on entity_relationships directly without an extra
  // join back through entities, mirroring message_entities' own
  // denormalization-for-query-simplicity precedent.
  await knex.raw(`
    CREATE TABLE entity_relationships (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relationship_type VARCHAR(30) NOT NULL,
        created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CHECK (source_entity_id <> target_entity_id),
        UNIQUE (source_entity_id, target_entity_id, relationship_type)
    )
  `);
  await knex.raw('CREATE INDEX idx_entity_relationships_source ON entity_relationships(source_entity_id)');
  await knex.raw('CREATE INDEX idx_entity_relationships_target ON entity_relationships(target_entity_id)');

  // One row per generated summary (a revision history, not a single
  // overwritten cache row) — FEATURE_REQUEST.md entry 4's design: "Store
  // generated summaries as revisions or cached snapshots... not as
  // unquestioned canonical truth." The entity detail route reads only the
  // most recent row per entity_id (idx below supports that lookup); nothing
  // deletes an older revision.
  await knex.raw(`
    CREATE TABLE entity_summaries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        summary_text TEXT NOT NULL,
        citations JSONB NOT NULL DEFAULT '[]',
        provider VARCHAR(50) NOT NULL,
        prompt_version VARCHAR(20) NOT NULL,
        generated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw('CREATE INDEX idx_entity_summaries_entity_generated ON entity_summaries(entity_id, generated_at DESC)');

  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON entity_relationships TO ??', [appDbUser]);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON entity_summaries TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw('REVOKE ALL PRIVILEGES ON entity_summaries FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS entity_summaries');

  await knex.raw('REVOKE ALL PRIVILEGES ON entity_relationships FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS entity_relationships');

  await knex.raw(`
    ALTER TABLE entities
      DROP COLUMN owner_id,
      DROP COLUMN status,
      DROP COLUMN tags,
      DROP COLUMN reference_url
  `);
}
