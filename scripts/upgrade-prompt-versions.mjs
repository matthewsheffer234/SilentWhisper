#!/usr/bin/env node
// Finding 2, docs/reviews/security-performance-review-2026-07-20.md.
//
// ensureDefaultSettingsSeeded()'s `onConflict('key').ignore()` (backend/src/
// llm/settingsService.js) means a deployment that ran before this fix and
// already has llm.summary_prompt_version/llm.task_prompt_version rows seeded
// as "v1" (docker-compose.yml's own prior default) will not self-correct
// just because the compose default changed — the seed step only fills in
// keys that don't already exist. This is a one-time operator script to fix
// up any such already-seeded rows.
//
// Same shape as grant-system-admin.mjs: its own tiny dependency tree, reuses
// backend/.env directly, connects as APP_DB_USER (app_runtime_user) rather
// than admin/migration credentials. Only ever touches rows currently set to
// "v1" (the JSON-encoded string) for exactly these two keys — an admin who
// has deliberately re-selected "v1" through some future settings surface
// isn't a case this codebase supports today (PROMPT_VERSIONS only allows
// "v2"), so there's nothing to preserve here beyond "don't touch anything
// this script wasn't asked to touch."

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const KEYS = ['llm.summary_prompt_version', 'llm.task_prompt_version'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (expected in backend/.env on the host, or already injected via Docker Compose/the container environment when run inside a container)`);
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
      `UPDATE app_settings SET value = '"v2"', updated_at = now()
       WHERE key = ANY($1) AND value = '"v1"'
       RETURNING key`,
      [KEYS],
    );
  } finally {
    await client.end();
  }

  if (result.rows.length === 0) {
    console.log('No llm.summary_prompt_version/llm.task_prompt_version rows were set to "v1" — nothing to do.');
  } else {
    for (const row of result.rows) {
      console.log(`Upgraded ${row.key} from "v1" to "v2".`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('upgrade-prompt-versions failed to run:', err.message);
  process.exit(2);
});
