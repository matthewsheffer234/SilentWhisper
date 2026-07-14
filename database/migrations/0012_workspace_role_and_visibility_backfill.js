// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1: the
// data-migration half of the schema laid down in 0011. This is the risky
// migration in the set — it rewrites the meaning of existing rows, not just
// adds columns — so each step is kept small and independently readable.
//
// Pre-flight check for anyone running this against real data (not
// auto-enforced by the migration itself, since inventing an owner is a real
// decision this script shouldn't make silently):
//
//   SELECT id, name FROM workspaces WHERE owner_id IS NULL;
//
// If that returns any rows, resolve them (assign an owner) before applying
// this migration — step 4 below cannot manufacture an owner for a workspace
// that has none.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // 1. Seed one default organization and backfill every workspace onto it,
  //    then constrain organization_id NOT NULL now that every row has a
  //    value (0011 added the column nullable specifically to allow this
  //    order: add column, backfill, constrain).
  const {
    rows: [defaultOrg],
  } = await knex.raw(`INSERT INTO organizations (name) VALUES ('Default Organization') RETURNING id`);

  await knex.raw('UPDATE workspaces SET organization_id = ? WHERE organization_id IS NULL', [defaultOrg.id]);
  await knex.raw('ALTER TABLE workspaces ALTER COLUMN organization_id SET NOT NULL');

  // 2. Baseline org membership for every user already active in some
  //    workspace. No invented ORG_ADMIN promotion here, per the design's own
  //    text — everyone lands as a plain ORG_MEMBER of the default org.
  await knex.raw(
    `
    INSERT INTO organization_members (organization_id, user_id, org_role)
    SELECT DISTINCT ?::uuid, wm.user_id, 'ORG_MEMBER'
    FROM workspace_members wm
    ON CONFLICT DO NOTHING
  `,
    [defaultOrg.id],
  );

  // 3. Workspace role rename. Order matters: flip the owner's row to OWNER
  //    FIRST, regardless of its current value — this also catches the case
  //    where an owner's own row was somehow 'MEMBER', not just 'ADMIN' — and
  //    only THEN convert every remaining ADMIN row to MANAGER, so the
  //    owner's row is never caught (and overwritten to MANAGER) by the
  //    second update.
  await knex.raw(`
    UPDATE workspace_members wm
    SET system_role = 'OWNER'
    FROM workspaces w
    WHERE w.id = wm.workspace_id AND w.owner_id = wm.user_id
  `);

  await knex.raw(`
    UPDATE workspace_members
    SET system_role = 'MANAGER'
    WHERE system_role = 'ADMIN'
  `);

  // 4. Edge case flagged in membershipService.js's own comment on
  //    requireWorkspaceOwnerOrAdmin: an owner with no workspace_members row
  //    at all (a case the pre-existing schema allowed, with no FK/trigger
  //    preventing it). Insert one as OWNER so "every workspace has exactly
  //    one OWNER" holds immediately post-migration, not just going forward.
  await knex.raw(`
    INSERT INTO workspace_members (workspace_id, user_id, system_role)
    SELECT w.id, w.owner_id, 'OWNER'
    FROM workspaces w
    WHERE w.owner_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = w.id AND wm.user_id = w.owner_id
      )
  `);

  // 5. Visibility data rename (the column itself stays VARCHAR(20); only the
  //    value domain changes — same "data update, not a column rename"
  //    approach FEATURE_REQUEST.md's own design specifies).
  await knex.raw(`UPDATE workspaces SET visibility = 'DISCOVERABLE' WHERE visibility = 'PUBLIC'`);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Best-effort and lossy, matching this migration set's existing down()
  // fidelity (0007's down() comment: "Role itself is left in place on
  // rollback"). Does not attempt to remove the organization_members rows
  // backfilled in step 2 or the synthetic OWNER rows inserted in step 4 —
  // nothing in this migration tracks which rows were inserted vs. updated,
  // and no earlier migration in this set does either.
  await knex.raw(`UPDATE workspaces SET visibility = 'PUBLIC' WHERE visibility = 'DISCOVERABLE'`);
  await knex.raw(`UPDATE workspace_members SET system_role = 'ADMIN' WHERE system_role IN ('OWNER', 'MANAGER')`);
  await knex.raw('ALTER TABLE workspaces ALTER COLUMN organization_id DROP NOT NULL');
}
