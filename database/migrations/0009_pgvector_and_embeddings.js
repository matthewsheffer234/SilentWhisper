// FEATURE_REQUEST.md entry 1, semantic message & channel search. Requires
// the pgvector-enabled Postgres image (pgvector/pgvector:pg16 —
// docker-compose.yml's `postgres` service; postgres:16-alpine has no
// `vector` extension available).
//
// message_embeddings is a separate table (not columns bolted onto
// `messages`), same instinct as `refresh_tokens`/`app_settings`: one
// embedding per message, produced asynchronously after the message itself
// commits. vector(384) matches the default embedding model (`all-minilm`,
// EMBEDDING_DIMENSION in backend/src/config.js) — deliberately a fixed
// dimension, not derived at runtime, so a future model swap to a different
// output size is a conscious new migration, not a silent insert failure.
//
// embedding_jobs is a lightweight DB-backed work queue (PROJECT_PLAN.md
// Section 2's "single instance" scale makes this an acceptable substitute
// for a separate worker system): one row per message, not an append-only
// log. A completed job's row is deleted by the worker (the embedding now
// lives in message_embeddings); a row that exhausts EMBEDDING_MAX_ATTEMPTS
// is left behind with status='failed' as a visible dead-letter.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');

  await knex.raw(`
    CREATE TABLE message_embeddings (
      message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      embedding vector(384) NOT NULL,
      model VARCHAR(100) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // HNSW, not ivfflat: builds incrementally with no upfront training-list
  // sizing, which fits a table that starts empty and grows via streaming
  // inserts from the ingestion worker rather than a one-time bulk load.
  await knex.raw(`
    CREATE INDEX idx_message_embeddings_hnsw
      ON message_embeddings USING hnsw (embedding vector_cosine_ops)
  `);

  await knex.raw(`
    CREATE TABLE embedding_jobs (
      message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw('CREATE INDEX idx_embedding_jobs_status ON embedding_jobs(status, created_at)');

  // Section 5, Database Access Rights: same GRANT set every other
  // application table gets, extended to the two new tables. Mirrors
  // 0007_grants.js's `??`-bound role-name pattern rather than hardcoding
  // "app_runtime_user" as a literal.
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON message_embeddings, embedding_jobs TO ??',
    [appDbUser],
  );
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS embedding_jobs');
  await knex.raw('DROP TABLE IF EXISTS message_embeddings');
  await knex.raw('DROP EXTENSION IF EXISTS vector');
}
