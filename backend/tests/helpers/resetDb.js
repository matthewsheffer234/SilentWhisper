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
// workspaces.owner_id -> users, messages.user_id -> users, and now
// organization_members.user_id -> users) regardless of which ones happen to
// cascade — safe either way. organization_members has no route that writes
// to it in this slice, but it does have a real FK to users, so it must still
// be cleared before users can be deleted. organizations itself (just the
// one seeded "Default Organization" row) is never cleared — nothing ever
// references a user from it, so it isn't in anyone's way.
export async function resetDb(db) {
  await adminDb('messages').del();
  await db('channel_members').del();
  await adminDb('channels').del();
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
