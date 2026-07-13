// PROJECT_PLAN.md Section 4 extension (FEATURE_REQUEST.md: self-service
// workspace subscription). No CHECK constraint, matching the existing
// channels.type / workspace_members.system_role convention of enforcing
// the enum at the application layer (validation.js) rather than in the DB.
// Defaults every existing (and future, unless specified) workspace to
// PRIVATE — nothing becomes discoverable by accident.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE workspaces
      ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'PRIVATE'
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE workspaces
      DROP COLUMN IF EXISTS visibility
  `);
}
