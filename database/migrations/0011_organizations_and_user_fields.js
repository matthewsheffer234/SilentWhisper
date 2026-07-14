// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1:
// schema only, additive and non-breaking on its own — no existing row's
// meaning changes here. The workspace_members role rename and the default
// organization backfill that makes workspaces.organization_id safe to read
// happen in 0012, which must run after this one.
//
// display_name is backfilled from username and constrained NOT NULL in the
// same up() (mirrors 0011-adjacent precedent: add nullable, backfill,
// constrain, all in one migration, same shape 0012 uses for
// workspaces.organization_id). status/is_system_admin get safe defaults
// ('ACTIVE' / false) so no backfill step is needed for them.
//
// organization_id is left NULLable here on purpose — 0012 backfills every
// existing workspace onto a seeded default organization and only then adds
// the NOT NULL constraint, since a constraint can't be added before every
// row has a value.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE organizations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE organization_members (
        organization_id UUID NOT NULL REFERENCES organizations(id),
        user_id UUID NOT NULL REFERENCES users(id),
        org_role VARCHAR(20) NOT NULL DEFAULT 'ORG_MEMBER',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (organization_id, user_id)
    )
  `);

  await knex.raw('CREATE INDEX idx_organization_members_user ON organization_members(user_id)');

  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN display_name VARCHAR(100) NULL,
      ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      ADD COLUMN is_system_admin BOOLEAN NOT NULL DEFAULT false
  `);

  await knex.raw(`UPDATE users SET display_name = username WHERE display_name IS NULL`);
  await knex.raw(`ALTER TABLE users ALTER COLUMN display_name SET NOT NULL`);

  await knex.raw(`
    ALTER TABLE workspaces
      ADD COLUMN organization_id UUID NULL REFERENCES organizations(id),
      ADD COLUMN managers_can_archive BOOLEAN NOT NULL DEFAULT false
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE workspaces
      DROP COLUMN IF EXISTS organization_id,
      DROP COLUMN IF EXISTS managers_can_archive
  `);
  await knex.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS display_name,
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS is_system_admin
  `);
  await knex.raw('DROP TABLE IF EXISTS organization_members');
  await knex.raw('DROP TABLE IF EXISTS organizations');
}
