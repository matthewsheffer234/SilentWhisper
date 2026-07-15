import knexFactory from 'knex';
import 'dotenv/config';

// A second connection using admin/migration credentials — needed to clear
// audit_logs (Section 5) and, since FEATURE_REQUEST.md entry 1's slice 1
// (migration 0013), users/workspaces/channels/messages too, all of which
// app_runtime_user deliberately has no DELETE grant on anymore. Every other
// table is cleared through the app's own runtime connection, the same one
// the routes under test use.
const adminDb = knexFactory({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  },
  pool: { min: 1, max: 5 },
});

// Deletion order respects every FK that isn't ON DELETE CASCADE (e.g.
// workspaces.owner_id -> users, messages.user_id -> users,
// organization_members.user_id -> users, and now invitations.workspace_id/
// organization_id/invited_by -> workspaces/organizations/users) regardless
// of which ones happen to cascade — safe either way. invitations is cleared
// before workspaces/organizations/users for exactly that reason (no cascade
// specified on any of its three FKs). organizations itself is never
// cleared, including the extra rows organizations.test.js's creation tests
// add beyond the one seeded "Default Organization" — nothing asserts an
// exact global count, and the earliest-created row must never be deleted
// anyway (POST /auth/signup and invitation redemption both enroll into
// whichever org has the earliest created_at, so deleting it would break
// every subsequent signup in the same test run).
export async function resetDb(db) {
  // organizations.archived_by (System Admin panel: manage organizations and
  // existing users) references users(id) with no cascade, and organizations
  // itself is never cleared below (same reasoning as ever — the
  // earliest-created org must survive across the whole test run). Left
  // unhandled, archiving an org in one test would leave a dangling
  // archived_by reference that blocks every subsequent test's user deletion
  // below. Nulled, not restored — no test relies on archived_by surviving
  // across a reset.
  await adminDb('organizations').update({ archived_by: null });
  await adminDb('messages').del();
  await db('channel_members').del();
  await adminDb('channels').del();
  await db('invitations').del();
  await db('workspace_members').del();
  await adminDb('workspaces').del();
  await db('refresh_tokens').del();
  await db('organization_members').del();
  await adminDb('users').del();
  await adminDb('audit_logs').del();
}

export async function destroyResetDbConnection() {
  await adminDb.destroy();
}
