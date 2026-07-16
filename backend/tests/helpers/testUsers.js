import bcrypt from 'bcryptjs';
import { db } from '../../src/db.js';
import { signAccessToken } from '../../src/auth/jwt.js';

// Self-service signup is closed (FEATURE_REQUEST.md entry 1, slice 4) —
// there's no HTTP endpoint left for test seeding to call. Direct DB insert +
// direct JWT mint, no supertest round trip, no signupIpLimiter exposure.
// Computed once at module load: real bcrypt (any test that logs in with a
// seeded password keeps working unmodified) at a low, test-only cost
// factor — never production-exposed, this DB is wiped every beforeEach.
const TEST_PASSWORD = 'correct-horse-battery';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

// signup(username, opts?) — same name as the old HTTP-backed helper, just
// drops the `app` first argument, so most of the ~276 existing call sites
// need only `signup(app, ` -> `signup(`. Same
// {userId, username, accessToken} return shape as before.
export async function signup(username, { email, organizationId, displayName } = {}) {
  return db.transaction(async (trx) => {
    const [user] = await trx('users')
      .insert({
        username,
        email: email ?? `${username}@example.com`,
        password_hash: TEST_PASSWORD_HASH,
        // Defaults to username, matching every real account-creation path's
        // own backfill convention (admin.js, invitations.js) — tests that
        // need to prove displayName is rendered distinctly from username
        // pass an explicit override.
        display_name: displayName ?? username,
      })
      .returning(['id', 'username', 'display_name']);
    const orgId = organizationId ?? (await trx('organizations').orderBy('created_at', 'asc').first('id')).id;
    await trx('organization_members').insert({ organization_id: orgId, user_id: user.id, org_role: 'ORG_MEMBER' });
    return {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      accessToken: signAccessToken({ userId: user.id, username: user.username, displayName: user.display_name }),
    };
  });
}

// New (FEATURE_REQUEST.md line 61) — replaces the signup()+local
// makeSystemAdmin(userId) two-step duplicated in 4 test files.
export async function seedSystemAdmin(username, opts = {}) {
  const seeded = await signup(username, opts);
  await db('users').where({ id: seeded.userId }).update({ is_system_admin: true });
  return seeded;
}

export function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}
