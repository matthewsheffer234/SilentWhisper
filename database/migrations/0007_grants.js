// PROJECT_PLAN.md Section 5, "Database Access Rights". Creates the
// least-privilege app_runtime_user role the running app connects as
// (src/db.js / APP_DB_USER, APP_DB_PASSWORD) — distinct from the admin
// credentials (PG*) used to run migrations. The password is read from the
// environment at migration time and never hardcoded (Section 3, Zero
// hardcoding) — this migration fails loudly if APP_DB_PASSWORD is unset.

// Postgres DDL (CREATE ROLE / ALTER ROLE) does not accept server-side bind
// parameters for the password literal the way DML statements do — `knex.raw`
// with a `?` binding sends it as a wire-protocol parameter ($1), which
// Postgres rejects for this statement type ("syntax error at or near $1").
// The password has to be embedded directly in the SQL text instead. It's
// dollar-quoted (rather than single-quote-escaped) so no escaping of
// special characters is needed; this value only ever comes from our own
// trusted environment configuration, never user input.
function asDollarQuotedLiteral(value) {
  return `$pwd$${value}$pwd$`;
}

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  const appDbPassword = process.env.APP_DB_PASSWORD;
  if (!appDbPassword) {
    throw new Error(
      'APP_DB_PASSWORD must be set in the environment before running migrations (see backend/.env.example).',
    );
  }
  if (appDbPassword.includes('$pwd$')) {
    throw new Error('APP_DB_PASSWORD must not contain the literal sequence "$pwd$".');
  }

  const passwordLiteral = asDollarQuotedLiteral(appDbPassword);
  const { rows } = await knex.raw('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ?', [appDbUser]);
  if (rows.length === 0) {
    await knex.raw(`CREATE ROLE ?? LOGIN PASSWORD ${passwordLiteral}`, [appDbUser]);
  } else {
    await knex.raw(`ALTER ROLE ?? WITH PASSWORD ${passwordLiteral}`, [appDbUser]);
  }

  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE
     ON users, workspace_members, workspaces, channels, channel_members, messages, refresh_tokens, app_settings
     TO ??`,
    [appDbUser],
  );

  await knex.raw('GRANT SELECT, INSERT ON audit_logs TO ??', [appDbUser]);
  await knex.raw('GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO ??', [appDbUser]);
  await knex.raw('REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM ??', [appDbUser]);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  const appDbUser = process.env.APP_DB_USER || 'app_runtime_user';
  await knex.raw('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ??', [appDbUser]);
  // Role itself is left in place on rollback (other databases/sessions may
  // depend on it); drop manually with DROP ROLE if truly decommissioning.
}
