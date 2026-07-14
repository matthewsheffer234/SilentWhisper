// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 2:
// the invitations table. scope_type/invited_role are app-enforced enums, no
// DB CHECK, matching every other role/type column in this schema
// (workspace_members.system_role, workspaces.visibility, channels.type all
// follow the same convention). No CHECK enforcing "exactly one of
// organization_id/workspace_id is set" either, for the same reason.
//
// status is a real stored column (PENDING/ACCEPTED/REVOKED), not fully
// derived — those are things that happen *to* a row (a write). EXPIRED is
// not a stored value: it's checked live as `expires_at < now()` at read
// time, on top of `status = 'PENDING'`, mirroring exactly how
// refresh_tokens handles expiry (a real revoked_at column, but expiry
// itself is computed, not stored) with no sweeper job needed for either
// table.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE invitations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        scope_type VARCHAR(20) NOT NULL,
        organization_id UUID NULL REFERENCES organizations(id),
        workspace_id UUID NULL REFERENCES workspaces(id),
        email VARCHAR(255) NOT NULL,
        invited_role VARCHAR(20) NOT NULL,
        invited_by UUID NOT NULL REFERENCES users(id),
        token_hash VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        accepted_at TIMESTAMP WITH TIME ZONE NULL,
        accepted_by UUID NULL REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  // Unique: this is the entire hot path for GET/:token and POST/:token/accept
  // (public, unauthenticated), so lookup-by-token stays a single index seek.
  await knex.raw('CREATE UNIQUE INDEX idx_invitations_token_hash ON invitations(token_hash)');

  // Partial, not full — scope_type guarantees at most one of these two
  // columns is ever non-null per row. Used by the "pending invitations for
  // this org/workspace" read the roster/revoke flow needs.
  await knex.raw('CREATE INDEX idx_invitations_org ON invitations(organization_id) WHERE organization_id IS NOT NULL');
  await knex.raw('CREATE INDEX idx_invitations_workspace ON invitations(workspace_id) WHERE workspace_id IS NOT NULL');

  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  // DELETE granted — matches organization_members/workspace_members/
  // refresh_tokens' precedent (0007, 0013): a membership/session/invitation
  // row is deletable, removing one isn't a hard-delete of an object the
  // audit log references. Not used by any route this slice (revoke is a
  // status flip, not a DELETE) — granted for symmetry and to avoid a
  // follow-up grants migration if a future slice adds invitation cleanup.
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON invitations FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS invitations');
}
