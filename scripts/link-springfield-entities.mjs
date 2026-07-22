#!/usr/bin/env node
// One-time follow-up to seed-springfield-investigation.mjs: rewrites a
// handful of already-seeded messages to wrap recurring nouns in [[double
// brackets]] (entityService.js's ENTITY_RE) so the entity registry has real,
// cross-channel data to demo — a single [[Mr. Burns]] entity page showing
// references pulled from #general, #ballistics-and-clues, and
// #suspect-alibis at once.
//
// There is no message-edit endpoint anywhere in this app (routes/messages.js
// only ever exposes GET/POST) — messages are otherwise immutable once sent,
// by design. Rewriting content is therefore a direct Postgres UPDATE, same
// least-privilege app_runtime_user connection every other /scripts tool
// uses (Section 5 grants UPDATE on messages). Editing message content itself
// carries no audit/integrity concern the way audit_logs would — messages
// aren't part of the hash chain — but the entity *side effect* normally only
// happens inside routes/messages.js's POST handler
// (linkMessageEntities(db, ...), called only `if (channel.workspace_id)` —
// DMs are workspace_id NULL and deliberately never get entity-linked, so
// this script doesn't touch the DM either, matching that same rule).
//
// Reuses extractEntityNames/normalizeEntityName directly from
// entityService.js by relative import (same precedent
// verify-audit-log.mjs already sets for auditService.js) since those two
// are pure, dependency-free functions — but NOT linkMessageEntities itself,
// which expects a Knex query-builder `db` object; this script only has a
// plain `pg` client (scripts/package.json's own tiny dependency tree has no
// knex), so the db-touching half of that function is reimplemented here
// with raw SQL, same find-or-create-by-normalized-name /
// insert-into-message_entities-on-conflict-ignore semantics.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { extractEntityNames } from '../backend/src/services/entityService.js';

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

// Each entry's `match` must appear in exactly one message's current content
// (asserted below) — a guard against accidentally rewriting the wrong row if
// the seed data ever changes. `author` is the username whose id becomes the
// edited message's re-linked entity `created_by` where a new entity is
// created here, matching what the real send-time pipeline would have
// recorded.
const EDITS = [
  {
    author: 'lisa_sleuth',
    match: 'the shooting of C. Montgomery Burns.**',
    replace: 'the shooting of [[Mr. Burns]] (C. Montgomery Burns).**',
  },
  {
    author: 'lisa_sleuth',
    match: 'cross-reference every registered 0.38 revolver owner',
    replace: 'cross-reference every registered [[0.38 revolver]] owner',
  },
  {
    author: 'wiggum',
    match: "We've got the registry, Lisa",
    replace: "We've got the [[0.38 revolver]] registry, Lisa",
  },
  {
    author: 'lisa_sleuth',
    match: "a partial thumbprint on a magnifying glass found near the scene. It doesn't match Mr. Burns' own prints.",
    replace:
      "a partial thumbprint on the [[magnifying glass]] found near the scene. It doesn't match [[Mr. Burns]]' own prints.",
  },
  {
    author: 'wiggum',
    match: "unveiling of Mr. Burns' new slant-drilling oil rig",
    replace: "unveiling of [[Mr. Burns]]' new [[slant-drilling oil rig]]",
  },
  {
    author: 'homer_j',
    match: 'why Mr. Burns handed *me* a commemorative photo',
    replace: 'why [[Mr. Burns]] handed *me* a commemorative photo',
  },
  {
    author: 'skinner_s',
    match: 'a **replacement gun-range silencer**?',
    replace: 'a **replacement gun-range [[silencer]]**?',
  },
  {
    author: 'wiggum',
    match: 'before we start naming names out loud.',
    replace: "before we start naming names out loud regarding [[Mr. Burns]]' shooting.",
  },
  {
    author: 'wiggum',
    match: 'asking me about a missing silencer of all things',
    replace: 'asking me about a missing [[silencer]] of all things',
  },
  {
    author: 'lisa_sleuth',
    match: 'prints come back from the magnifying glass check',
    replace: 'prints come back from the [[magnifying glass]] check',
  },
];

async function linkEntitiesForMessage(client, { content, messageId, workspaceId, createdBy }) {
  const extracted = extractEntityNames(content);
  if (extracted.length === 0) return [];

  const linked = [];
  for (const { canonicalName, normalizedName } of extracted) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await client.query(
      `SELECT id FROM entities WHERE workspace_id = $1 AND (normalized_name = $2 OR $2 = ANY(aliases))`,
      [workspaceId, normalizedName],
    );
    let entityId = existing.rows[0]?.id;
    if (!entityId) {
      // eslint-disable-next-line no-await-in-loop
      const inserted = await client.query(
        `INSERT INTO entities (workspace_id, canonical_name, normalized_name, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, normalized_name) DO NOTHING
         RETURNING id`,
        [workspaceId, canonicalName, normalizedName, createdBy],
      );
      entityId = inserted.rows[0]?.id;
      if (!entityId) {
        // Lost a race against another insert of the same normalized name —
        // re-select, mirroring entityService.js's own fallback.
        // eslint-disable-next-line no-await-in-loop
        const refetch = await client.query(
          `SELECT id FROM entities WHERE workspace_id = $1 AND normalized_name = $2`,
          [workspaceId, normalizedName],
        );
        entityId = refetch.rows[0]?.id;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO message_entities (message_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, entityId],
    );
    linked.push(canonicalName);
  }
  return linked;
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

  try {
    const {
      rows: [workspace],
    } = await client.query("SELECT id FROM workspaces WHERE name = 'Springfield Investigation Taskforce'");
    if (!workspace) {
      console.error('Workspace "Springfield Investigation Taskforce" not found — run seed-springfield-investigation.mjs first.');
      process.exit(1);
    }

    for (const edit of EDITS) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: matches } = await client.query(
        `SELECT m.id, m.content, m.user_id, c.workspace_id
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         WHERE c.workspace_id = $1 AND m.content LIKE '%' || $2 || '%'`,
        [workspace.id, edit.match],
      );
      if (matches.length !== 1) {
        throw new Error(`Expected exactly 1 message matching "${edit.match}", found ${matches.length}`);
      }
      const message = matches[0];
      const newContent = message.content.replace(edit.match, edit.replace);

      // eslint-disable-next-line no-await-in-loop
      await client.query('UPDATE messages SET content = $1 WHERE id = $2', [newContent, message.id]);

      // eslint-disable-next-line no-await-in-loop
      const {
        rows: [author],
      } = await client.query('SELECT id FROM users WHERE username = $1', [edit.author]);

      // eslint-disable-next-line no-await-in-loop
      const linked = await linkEntitiesForMessage(client, {
        content: newContent,
        messageId: message.id,
        workspaceId: workspace.id,
        createdBy: author.id,
      });
      console.log(`Linked [${linked.join(', ')}] on message ${message.id}`);
    }

    const { rows: summary } = await client.query(
      `SELECT e.canonical_name, count(*) AS reference_count
       FROM message_entities me
       JOIN entities e ON e.id = me.entity_id
       WHERE e.workspace_id = $1
       GROUP BY e.canonical_name
       ORDER BY reference_count DESC`,
      [workspace.id],
    );
    console.log('\nEntity registry now:');
    for (const row of summary) {
      console.log(`  ${row.canonical_name}: ${row.reference_count} reference(s)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('link-springfield-entities failed:', err);
  process.exit(1);
});
