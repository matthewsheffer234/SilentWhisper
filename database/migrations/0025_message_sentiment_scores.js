// FEATURE_REQUEST.md's Admin Analytics Dashboard entry, "aggregate
// semantic/sentiment trend". Same one-row-per-message shape as
// message_embeddings (0009_pgvector_and_embeddings.js) — populated by
// search/embeddingWorker.js's existing per-message embedding pass
// (search/sentimentService.js), not a second queue/worker. No separate
// index needed: the trend query (routes/adminAnalytics.js) joins through
// messages.created_at for bucketing, never filters on this table's own
// computed_at.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE message_sentiment_scores (
      message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      model VARCHAR(100) NOT NULL,
      computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Section 5, Database Access Rights: same GRANT set every other
  // application table gets, mirroring 0009/0020's `??`-bound role-name
  // pattern rather than hardcoding "app_runtime_user" as a literal.
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON message_sentiment_scores TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON message_sentiment_scores FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS message_sentiment_scores');
}
