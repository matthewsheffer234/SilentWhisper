import knexFactory from 'knex';
import 'dotenv/config';

// CLAUDE.md's own standing warning: this file unconditionally deletes every
// user (and everything that cascades from it) before nearly every test, and
// must only ever run against silent_whisper_test. That warning was
// comment-only, not mechanically enforced — and on 2026-07-20 a bare
// `node ... jest ...` invocation (skipping the `PGDATABASE=silent_whisper_test`
// prefix `npm test` normally bakes in, per package.json's own "test" script)
// silently fell through to this same dotenv import loading backend/.env's
// *real* PGDATABASE value instead, and resetDb() below wiped the live
// production database: every user (including the real system admin
// account), every workspace/channel/message, and the entire audit_logs
// table. A comment wasn't enough to prevent that from happening twice
// (PROJECT_PLAN.md Section 11 already documents a near-identical prior
// incident) — this is a hard, mechanical refusal instead. Placed
// immediately after the dotenv import and before adminDb is even
// constructed below, so a misconfigured invocation fails loudly the instant
// this module loads, before a single connection — let alone query — exists.
const EXPECTED_TEST_DATABASE = 'silent_whisper_test';
if (process.env.PGDATABASE !== EXPECTED_TEST_DATABASE) {
  throw new Error(
    `resetDb.js refused to load: PGDATABASE is "${process.env.PGDATABASE}", not "${EXPECTED_TEST_DATABASE}". ` +
      'This module unconditionally deletes every user and everything that cascades from it. ' +
      'Always run tests via "npm test" (package.json bakes in the correct PGDATABASE) — never a bare `node ...jest` invocation.',
  );
}

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
  await db('mention_notifications').del();
  await db('user_notifications').del();
  await db('message_entities').del();
  await db('entities').del();
  await adminDb('messages').del();
  await db('channel_members').del();
  await adminDb('channels').del();
  await db('invitations').del();
  await db('membership_invitations').del();
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
