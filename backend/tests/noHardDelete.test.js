import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1,
// migration 0013. `db` connects as app_runtime_user (see src/db.js) — the
// same least-privilege role the running app uses — so these assertions
// prove the grant actually holds at the database level, not just that no
// route happens to call .del(). Mirrors auditService.test.js's existing
// `.rejects.toThrow(/permission denied/i)` pattern for the audit_logs
// append-only grant, extended here to the four tables migration 0013
// revoked DELETE from.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('no-hard-delete grants (migration 0013)', () => {
  test('app_runtime_user cannot DELETE from users, workspaces, channels, or messages', async () => {
    await expect(db('users').del()).rejects.toThrow(/permission denied/i);
    await expect(db('workspaces').del()).rejects.toThrow(/permission denied/i);
    await expect(db('channels').del()).rejects.toThrow(/permission denied/i);
    await expect(db('messages').del()).rejects.toThrow(/permission denied/i);
  });
});

describe('organizations grants (migration 0013)', () => {
  test('app_runtime_user can SELECT organizations — the query POST /workspaces relies on', async () => {
    const rows = await db('organizations').select('id');
    expect(rows.length).toBeGreaterThanOrEqual(1); // the seeded "Default Organization" from migration 0012
  });

  test('app_runtime_user cannot DELETE from organizations', async () => {
    await expect(db('organizations').del()).rejects.toThrow(/permission denied/i);
  });
});
