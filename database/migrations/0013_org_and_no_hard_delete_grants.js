// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1.
// 0007_grants.js's GRANT statement is a fixed table list, not a schema-wide
// grant — it does not cover organizations/organization_members, created by
// 0011. Without this, the first `SELECT id FROM organizations` a route
// issues (POST /workspaces, looking up the seeded default org) fails with
// "permission denied for table organizations".
//
// Also extends the audit_logs append-only precedent (0007: GRANT without
// DELETE, then an explicit REVOKE) onto users/workspaces/channels/messages —
// all four currently have DELETE from 0007's original broad grant, even
// though no route anywhere uses it (confirmed: no router.delete/.del()/
// DELETE FROM against these tables in backend/src/routes/*.js). This is
// defense-in-depth, not a behavior change.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  // No DELETE, ever — organizations is on the no-hard-delete list from day
  // one, so unlike the four REVOKEs below there's nothing to revoke later.
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON organizations TO ??', [appDbUser]);

  // Matches workspace_members' existing DELETE grant (0007) — a membership
  // row is deletable (removing someone from a workspace/org is itself an
  // audited event, not a hard-delete of the audited object itself), even
  // though no route uses this yet in slice 1.
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO ??', [appDbUser]);

  await knex.raw('REVOKE DELETE ON users, workspaces, channels, messages FROM ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('GRANT DELETE ON users, workspaces, channels, messages TO ??', [appDbUser]);
  await knex.raw('REVOKE ALL PRIVILEGES ON organization_members FROM ??', [appDbUser]);
  await knex.raw('REVOKE ALL PRIVILEGES ON organizations FROM ??', [appDbUser]);
}
