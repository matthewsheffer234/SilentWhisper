// FEATURE_REQUEST.md "Live notification system + in-app invitation
// notification & acceptance workflow": generalizes mention_notifications'
// shape into a sibling table covering other notification types, and adds a
// wholly separate, username-addressed membership-invitation object for
// existing accounts (distinct from invitations.js's token-based invitations,
// which onboard someone with no account yet).
//
// mention_notifications is deliberately left untouched (its dedupe/read-state
// logic is battle-tested) — unified only at the API/UI layer via a merged
// GET /api/notifications/summary. Lower migration risk than folding mentions
// into this new table.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';

  await knex.raw(`
    CREATE TABLE user_notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        read_at TIMESTAMP WITH TIME ZONE
    )
  `);
  await knex.raw(`
    CREATE INDEX idx_user_notifications_recipient_unread_date
      ON user_notifications(recipient_user_id, read_at, created_at DESC)
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON user_notifications TO ??', [appDbUser]);

  // scope_type/invited_role app-enforced enums, no DB CHECK — same
  // convention as invitations.scope_type/invited_role (0014). No CHECK
  // enforcing "exactly one of organization_id/workspace_id is set" either,
  // for the same reason.
  await knex.raw(`
    CREATE TABLE membership_invitations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        scope_type VARCHAR(20) NOT NULL,
        organization_id UUID NULL REFERENCES organizations(id),
        workspace_id UUID NULL REFERENCES workspaces(id),
        invited_user_id UUID NOT NULL REFERENCES users(id),
        invited_role VARCHAR(20) NOT NULL,
        invited_by UUID NOT NULL REFERENCES users(id),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        resolved_at TIMESTAMP WITH TIME ZONE NULL
    )
  `);
  await knex.raw(`
    CREATE INDEX idx_membership_invitations_invited_user_status
      ON membership_invitations(invited_user_id, status)
  `);
  await knex.raw(
    'CREATE INDEX idx_membership_invitations_org ON membership_invitations(organization_id) WHERE organization_id IS NOT NULL',
  );
  await knex.raw(
    'CREATE INDEX idx_membership_invitations_workspace ON membership_invitations(workspace_id) WHERE workspace_id IS NOT NULL',
  );
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON membership_invitations TO ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON membership_invitations FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS membership_invitations');
  await knex.raw('REVOKE ALL PRIVILEGES ON user_notifications FROM ??', [appDbUser]);
  await knex.raw('DROP TABLE IF EXISTS user_notifications');
}
