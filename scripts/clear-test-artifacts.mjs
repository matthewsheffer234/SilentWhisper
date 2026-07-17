#!/usr/bin/env node
// Sweeps e2e-test-created accounts (and everything that cascades from them)
// out of the dev database after a test run, per the operator's standing
// instruction: "all test artifacts should be cleaned from the database
// after tests are run; preserve logs always." Wired into
// `frontend/playwright.config.js`'s `globalTeardown` so this runs
// automatically after every `npm run test:e2e`, not just on request.
//
// This does NOT touch backend/tests/helpers/resetDb.js's target
// (silent_whisper_test) — that database is already unconditionally wiped
// before nearly every backend test (CLAUDE.md's own warning about that
// function is exactly why it must never be reused here). This script
// instead targets the live dev database (PGDATABASE, normally
// `silent_whisper`) that `npm run test:e2e` seeds real rows into with no
// teardown of its own.
//
// Deliberately an ALLOWLIST match on username prefix (delete only rows that
// look like test data), not a denylist of "every user except these two" —
// an allowlist can never delete a real account by accident just because it
// wasn't on a hardcoded preserve list, which matters a lot more for a script
// that runs unattended after every test run than it did for the one-off
// manual cleanup this was generalized from. Every test-account-creating path
// in frontend/e2e/workflows.spec.js already uses one of these prefixes
// (`uniqueUsername()` for API-seeded accounts, three literal prefixes for
// the admin-UI-driven creation flows) — add a new prefix here if a future
// test introduces another one, or better, just reuse `e2e_` for it.
//
// Never touches audit_logs: its prev_row_hash/curr_row_hash chain
// (backend/src/audit/auditService.js) is sequential across every row
// regardless of actor, so deleting even test-only rows from the middle of
// it would break `scripts/verify-audit-log.mjs` for every real row that
// follows — confirmed with the operator before this was ever run, and now a
// hard invariant of this script, not a per-run judgment call.
//
// Own tiny dependency tree (dotenv + pg only), same as every other script in
// this directory — connects with the migration role (PGUSER/PGPASSWORD),
// not APP_DB_USER, since app_runtime_user has no DELETE grant on
// users/workspaces/channels/messages (migration 0013 revoked it on purpose).

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const DEFAULT_PREFIXES = ['e2e_', 'mgmt_created_', 'resetflow_created_', 'dn_created_'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (expected in backend/.env)`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const prefixes = argv.filter((a) => a.startsWith('--prefix=')).map((a) => a.slice('--prefix='.length));
  return { dryRun, prefixes: prefixes.length > 0 ? prefixes : DEFAULT_PREFIXES };
}

async function main() {
  const { dryRun, prefixes } = parseArgs(process.argv.slice(2));
  const likePatterns = prefixes.map((p) => `${p}%`);

  const client = new pg.Client({
    host: requireEnv('PGHOST'),
    port: Number(process.env.PGPORT || 5432),
    user: requireEnv('PGUSER'),
    password: requireEnv('PGPASSWORD'),
    database: requireEnv('PGDATABASE'),
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    const { rows: testUserRows } = await client.query('SELECT id, username FROM users WHERE username LIKE ANY($1::text[])', [
      likePatterns,
    ]);
    const testUserIds = testUserRows.map((r) => r.id);

    if (testUserIds.length === 0) {
      console.log(`No users match prefixes [${prefixes.join(', ')}] in ${process.env.PGDATABASE}. Nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }

    const { rows: testWorkspaceRows } = await client.query('SELECT id FROM workspaces WHERE owner_id = ANY($1::uuid[])', [
      testUserIds,
    ]);
    const testWorkspaceIds = testWorkspaceRows.map((r) => r.id);

    // DIRECT/GROUP_DM channels have workspace_id NULL — a "test" one is
    // defined as a DM whose every member is a test account, so a DM that
    // happens to include a real account is left alone even if the other
    // participant is a test one.
    const { rows: dmChannelRows } = await client.query(
      `SELECT c.id FROM channels c
       WHERE c.workspace_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND NOT (cm.user_id = ANY($1::uuid[]))
         )`,
      [testUserIds],
    );
    const workspaceChannelRows = testWorkspaceIds.length
      ? (await client.query('SELECT id FROM channels WHERE workspace_id = ANY($1::uuid[])', [testWorkspaceIds])).rows
      : [];
    const testChannelIds = [...dmChannelRows, ...workspaceChannelRows].map((r) => r.id);

    console.log(`Prefixes: ${prefixes.join(', ')}`);
    console.log(`Test users to delete: ${testUserIds.length}`);
    console.log(`Test workspaces to delete: ${testWorkspaceIds.length}`);
    console.log(`Test channels to delete (incl. DMs): ${testChannelIds.length}`);

    if (dryRun) {
      console.log('--dry-run: no changes made.');
      await client.query('ROLLBACK');
      return;
    }

    // Null out NO-ACTION references to test users on rows that are NOT
    // themselves being deleted, so the later user delete doesn't hit a FK
    // violation and nothing real is left pointing at a deleted row.
    await client.query('UPDATE organizations SET archived_by = NULL WHERE archived_by = ANY($1::uuid[])', [testUserIds]);
    await client.query(
      `UPDATE workspaces SET archived_by = NULL
       WHERE archived_by = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`,
      [testUserIds, testWorkspaceIds.length ? testWorkspaceIds : ['00000000-0000-0000-0000-000000000000']],
    );
    const { rows: appSettingsTable } = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'app_settings'",
    );
    if (appSettingsTable.length > 0) {
      await client.query('UPDATE app_settings SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])', [testUserIds]);
    }

    // mention_notifications.mentioned_by_user_id is NO ACTION (unlike
    // recipient_user_id/channel_id/workspace_id, which cascade) — deleted
    // explicitly here covering every direction rather than relying on
    // partial cascade behavior.
    const mentionNotif = await client.query(
      `DELETE FROM mention_notifications
       WHERE recipient_user_id = ANY($1::uuid[])
          OR mentioned_by_user_id = ANY($1::uuid[])
          OR channel_id = ANY($2::uuid[])
          OR workspace_id = ANY($3::uuid[])`,
      [testUserIds, testChannelIds.length ? testChannelIds : ['00000000-0000-0000-0000-000000000000'], testWorkspaceIds.length ? testWorkspaceIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const userNotif = await client.query('DELETE FROM user_notifications WHERE recipient_user_id = ANY($1::uuid[])', [
      testUserIds,
    ]);

    const messages = await client.query(
      'DELETE FROM messages WHERE user_id = ANY($1::uuid[]) OR channel_id = ANY($2::uuid[])',
      [testUserIds, testChannelIds.length ? testChannelIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const channelMembers = await client.query(
      'DELETE FROM channel_members WHERE user_id = ANY($1::uuid[]) OR channel_id = ANY($2::uuid[])',
      [testUserIds, testChannelIds.length ? testChannelIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const channels = testChannelIds.length
      ? await client.query('DELETE FROM channels WHERE id = ANY($1::uuid[])', [testChannelIds])
      : { rowCount: 0 };

    const invitations = await client.query(
      `DELETE FROM invitations
       WHERE invited_by = ANY($1::uuid[]) OR accepted_by = ANY($1::uuid[]) OR workspace_id = ANY($2::uuid[])`,
      [testUserIds, testWorkspaceIds.length ? testWorkspaceIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const membershipInvitations = await client.query(
      `DELETE FROM membership_invitations
       WHERE invited_user_id = ANY($1::uuid[]) OR invited_by = ANY($1::uuid[]) OR workspace_id = ANY($2::uuid[])`,
      [testUserIds, testWorkspaceIds.length ? testWorkspaceIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const workspaceMembers = await client.query(
      'DELETE FROM workspace_members WHERE user_id = ANY($1::uuid[]) OR workspace_id = ANY($2::uuid[])',
      [testUserIds, testWorkspaceIds.length ? testWorkspaceIds : ['00000000-0000-0000-0000-000000000000']],
    );

    const workspaces = testWorkspaceIds.length
      ? await client.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [testWorkspaceIds])
      : { rowCount: 0 };

    const refreshTokens = await client.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])', [testUserIds]);
    const orgMembers = await client.query('DELETE FROM organization_members WHERE user_id = ANY($1::uuid[])', [testUserIds]);
    const users = await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [testUserIds]);

    await client.query('COMMIT');

    console.log('Deleted counts:', {
      mentionNotifications: mentionNotif.rowCount,
      userNotifications: userNotif.rowCount,
      messages: messages.rowCount,
      channelMembers: channelMembers.rowCount,
      channels: channels.rowCount,
      invitations: invitations.rowCount,
      membershipInvitations: membershipInvitations.rowCount,
      workspaceMembers: workspaceMembers.rowCount,
      workspaces: workspaces.rowCount,
      refreshTokens: refreshTokens.rowCount,
      organizationMembers: orgMembers.rowCount,
      users: users.rowCount,
    });
    console.log('audit_logs: untouched, by design — see header comment.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('clear-test-artifacts failed, transaction rolled back:', err.message);
  process.exit(2);
});
