#!/usr/bin/env node
// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4
// (SLICE_4_PLAN.md §4.7). Self-service signup is now closed, so the very
// first account in a fresh install has to be created out-of-band, the same
// way grant-system-admin.mjs already promotes a *later* existing account —
// this is the "there is no existing account yet" counterpart.
//
// Same shape as grant-system-admin.mjs: its own tiny dependency tree, reuses
// backend/.env directly, connects as APP_DB_USER (app_runtime_user). Adds
// bcryptjs (pure-JS, no native compile — the same reason the backend itself
// picked it) since, unlike grant-system-admin.mjs's single UPDATE, this
// script has to hash a real password. Imports assertUsername/assertEmail/
// assertValidPassword directly from backend/src by relative path — both
// modules are dependency-free within backend/src, the same precedent
// verify-audit-log.mjs already sets for reusing backend internals from an
// offline script.
//
// No appendAuditEvent call, no test file — matches grant-system-admin.mjs's
// own zero-audit, zero-test precedent for an offline, direct-DB tool.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { assertUsername, assertEmail } from '../backend/src/validation.js';
import { assertValidPassword } from '../backend/src/auth/passwordPolicy.js';
import { ValidationError } from '../backend/src/errors.js';

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
  const [username, email, password] = process.argv.slice(2);
  if (!username || !email || !password) {
    console.error('Usage: node create-first-admin.mjs <username> <email> <password>');
    process.exit(2);
  }

  try {
    assertUsername(username);
    assertEmail(email);
    const passwordError = assertValidPassword(password);
    if (passwordError) throw new ValidationError(passwordError);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const client = new pg.Client({
    host: requireEnv('PGHOST'),
    port: Number(process.env.PGPORT || 5432),
    user: requireEnv('APP_DB_USER'),
    password: requireEnv('APP_DB_PASSWORD'),
    database: requireEnv('PGDATABASE'),
  });

  await client.connect();

  try {
    const existing = await client.query('SELECT 1 FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (existing.rows.length > 0) {
      console.error('Username or email already in use.');
      process.exit(1);
    }

    // Hardcoded 12, matching config.js's own floor (Math.max(12, ...)) —
    // not importing config.js itself, which pulls in unrelated env parsing
    // (JWT secrets, LLM settings, etc.) this script has no use for.
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query('BEGIN');
    try {
      const userResult = await client.query(
        `INSERT INTO users (username, email, password_hash, display_name, is_system_admin)
         VALUES ($1, $2, $3, $1, true)
         RETURNING id`,
        [username, email, passwordHash],
      );
      const userId = userResult.rows[0].id;

      const orgResult = await client.query('SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1');
      if (orgResult.rows.length === 0) {
        // Should be unreachable — migration 0012 unconditionally seeds a
        // default organization before any account can exist. Skip the
        // org-membership insert and warn, rather than failing the whole run.
        console.warn('Warning: no organization exists; created the admin account with no organization membership.');
      } else {
        await client.query('INSERT INTO organization_members (organization_id, user_id, org_role) VALUES ($1, $2, $3)', [
          orgResult.rows[0].id,
          userId,
          'ORG_MEMBER',
        ]);
      }

      await client.query('COMMIT');
      console.log(`Created system admin ${username} (${userId})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('create-first-admin failed to run:', err.message);
  process.exit(2);
});
