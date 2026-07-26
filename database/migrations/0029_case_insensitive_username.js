// FEATURE_REQUEST.md backlog entry 2, "Usernames are case-sensitive at
// login". Login (auth.js) and account-creation uniqueness checks
// (admin.js, invitations.js) now compare usernames case-insensitively in
// application code; this migration makes that the enforced invariant at
// the schema level too; a future code path that forgets to case-fold
// before insert still can't create two accounts differing only by case.
//
// Replaces the plain `UNIQUE` btree constraint on users.username (from
// 0002_users_and_security.js) with a unique index on lower(username).
// Display casing is untouched — only the comparison used for uniqueness
// changes.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  // Log any pre-existing case-only collisions before attempting the
  // index, so an operator sees exactly which rows conflict instead of a
  // bare constraint-violation error with no context.
  const { rows: collisions } = await knex.raw(`
    SELECT lower(username) AS lower_username, array_agg(username ORDER BY created_at) AS usernames
    FROM users
    GROUP BY lower(username)
    HAVING count(*) > 1
  `);
  if (collisions.length > 0) {
    console.warn(
      `[0029_case_insensitive_username] ${collisions.length} username(s) collide case-insensitively; ` +
        'the unique index below will fail until these are resolved manually:',
      collisions.map((c) => c.usernames),
    );
  }

  await knex.raw('ALTER TABLE users DROP CONSTRAINT users_username_key');
  await knex.raw('CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username))');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS users_username_lower_unique');
  await knex.raw('ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username)');
}
