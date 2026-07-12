// PROJECT_PLAN.md Section 4 extension (FEATURE_REQUEST.md: workspace
// archive/unarchive). A nullable timestamp, not a boolean, matches the
// existing refresh_tokens.revoked_at convention — records *when*, not just
// *whether*. Both columns default NULL, so every existing workspace stays
// active with no backfill needed.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE workspaces
      ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE NULL,
      ADD COLUMN archived_by UUID REFERENCES users(id) NULL
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE workspaces
      DROP COLUMN IF EXISTS archived_at,
      DROP COLUMN IF EXISTS archived_by
  `);
}
