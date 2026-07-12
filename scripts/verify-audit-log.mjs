#!/usr/bin/env node
// PROJECT_PLAN.md Section 6, Immutable Local Auditing: "A verification
// script walks the audit log in order, recomputes each row hash, and
// reports either 'Log Integrity Verified' or the first row that fails
// validation."
//
// Deliberately its own tiny package (scripts/package.json: dotenv + pg
// only) rather than folded into /backend — this tool needs to work even if
// the backend app itself is broken or mid-deploy, so it shouldn't share a
// dependency tree or module graph with it. The one thing it does reuse from
// /backend is the hash math itself (computeRowHash/GENESIS_HASH), imported
// directly by relative path — safe because auditService.js has zero
// external package imports of its own (only Node's built-in `node:crypto`),
// so this cross-package import never needs backend/node_modules to resolve.
//
// Read-only: connects as the same least-privilege app_runtime_user role the
// backend itself uses (Section 5 grants it SELECT on audit_logs), and never
// writes. The API-driven equivalent (POST /api/audit/verify, used by the
// admin dashboard) does append an AUDIT_VERIFICATION_ATTEMPTED row per
// Section 6's "Admin audit verification attempts" tracked-event — this CLI
// tool is the direct-DB-access path for when the app itself may not be
// running, and intentionally stays out of the business of writing to the
// log it's checking.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { computeRowHash, GENESIS_HASH } from '../backend/src/audit/auditService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuses backend/.env verbatim rather than requiring a third copy of the
// same PG* connection variables — single source of truth for how this host
// reaches its own Postgres.
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (expected in backend/.env)`);
    process.exit(2);
  }
  return value;
}

async function main() {
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
      `SELECT id, timestamp, actor_id, actor_ip, action_type, target_resource, payload, prev_row_hash, curr_row_hash
       FROM audit_logs
       ORDER BY id ASC`,
    );
  } finally {
    await client.end();
  }

  const rows = result.rows;
  console.log(`Checking ${rows.length} audit_logs row(s)...`);

  let expectedPrevHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_row_hash !== expectedPrevHash) {
      reportFailure(row, "prev_row_hash does not match the previous row's curr_row_hash");
      process.exit(1);
    }

    const recomputed = computeRowHash({
      prevRowHash: row.prev_row_hash,
      actorId: row.actor_id,
      actorIp: row.actor_ip,
      actionType: row.action_type,
      targetResource: row.target_resource,
      payload: row.payload,
    });

    if (recomputed !== row.curr_row_hash) {
      reportFailure(row, 'curr_row_hash does not match the recomputed hash — row contents changed since it was written');
      process.exit(1);
    }

    expectedPrevHash = row.curr_row_hash;
  }

  console.log('Log Integrity Verified');
  console.log(`${rows.length} row(s) checked, chain intact from genesis to id=${rows.length ? rows[rows.length - 1].id : '(none)'}.`);
  process.exit(0);
}

function reportFailure(row, reason) {
  console.error('INTEGRITY CHECK FAILED');
  console.error(`First bad row: id=${row.id}`);
  console.error(`  timestamp:       ${row.timestamp?.toISOString?.() ?? row.timestamp}`);
  console.error(`  action_type:     ${row.action_type}`);
  console.error(`  actor_id:        ${row.actor_id}`);
  console.error(`  target_resource: ${row.target_resource ?? '(none)'}`);
  console.error(`  reason:          ${reason}`);
}

main().catch((err) => {
  console.error('verify-audit-log failed to run:', err.message);
  process.exit(2);
});
