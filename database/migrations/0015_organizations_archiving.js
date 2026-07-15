// System Admin panel: manage organizations and existing users. `organizations`
// has had DELETE revoked from app_runtime_user since 0013 (the same
// no-hard-delete-on-audit-referenced-entities guarantee users/workspaces/
// channels/messages get) — so "delete an organization" becomes archive,
// mirroring 0008_workspace_archiving.js exactly. A nullable timestamp, not a
// boolean, matches that same existing convention: records *when*, not just
// *whether*. Both columns default NULL, so every existing organization stays
// active with no backfill needed.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE organizations
      ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE NULL,
      ADD COLUMN archived_by UUID REFERENCES users(id) NULL
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS archived_at,
      DROP COLUMN IF EXISTS archived_by
  `);
}
