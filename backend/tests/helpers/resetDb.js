import knexFactory from 'knex';
import 'dotenv/config';

// A second connection using admin/migration credentials — needed only to
// clear audit_logs between tests, since app_runtime_user deliberately has no
// DELETE grant there (Section 5). Every other table is cleared through the
// app's own runtime connection, the same one the routes under test use.
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
// workspaces.owner_id -> users, messages.user_id -> users) regardless of
// which ones happen to cascade — safe either way.
export async function resetDb(db) {
  await db('messages').del();
  await db('channel_members').del();
  await db('channels').del();
  await db('workspace_members').del();
  await db('workspaces').del();
  await db('refresh_tokens').del();
  await db('users').del();
  await adminDb('audit_logs').del();
}

export async function destroyResetDbConnection() {
  await adminDb.destroy();
}
