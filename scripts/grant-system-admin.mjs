#!/usr/bin/env node
// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 1.
//
// is_system_admin (migration 0011) has no self-service or API-driven path
// yet in this slice — self-service signup stays open, but nothing in the
// running app ever sets is_system_admin. This CLI is the only way to
// produce a system admin until scripts/create-first-admin.mjs (a later
// slice, for the eventual signup-closed world) exists.
//
// Same shape as verify-audit-log.mjs: its own tiny dependency tree, reuses
// backend/.env directly, connects as APP_DB_USER (app_runtime_user) rather
// than admin/migration credentials — app_runtime_user already has UPDATE on
// users (migration 0013 only revoked DELETE), so no elevated credentials
// are needed for this one UPDATE.
//
// No appendAuditEvent call: this is a direct-DB offline tool, the same
// precedent verify-audit-log.mjs sets for "needs to work even if the app
// itself is broken or mid-deploy." An in-app, audited equivalent
// (SYSTEM_ADMIN_STATUS_CHANGE via an admin route) is explicitly a
// later-slice item per FEATURE_REQUEST.md's own design text, not this
// CLI's job.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (expected in backend/.env on the host, or already injected via Docker Compose/the container environment when run inside a container)`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const identifier = process.argv[2];
  if (!identifier) {
    console.error('Usage: node grant-system-admin.mjs <username-or-email>');
    process.exit(2);
  }

  const client = new pg.Client({
    host: requireEnv('PGHOST'),
    port: Number(process.env.PGPORT || 5432),
    user: requireEnv('APP_DB_USER'),
    password: requireEnv('APP_DB_PASSWORD'),
    database: requireEnv('PGDATABASE'),
  });

  await client.connect();

  let result;
  try {
    result = await client.query(
      `UPDATE users SET is_system_admin = true
       WHERE username = $1 OR email = $1
       RETURNING id, username, email, is_system_admin`,
      [identifier],
    );
  } finally {
    await client.end();
  }

  if (result.rows.length === 0) {
    console.error(`No user found with username or email: ${identifier}`);
    process.exit(1);
  }

  const user = result.rows[0];
  console.log(`Granted is_system_admin to ${user.username} (${user.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('grant-system-admin failed to run:', err.message);
  process.exit(2);
});
