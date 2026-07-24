#!/usr/bin/env node
// One-time operator script, same "fix up rows a code change couldn't
// retroactively reach" shape as upgrade-prompt-versions.mjs.
//
// The gap: search/embeddingWorker.js only computes message_sentiment_scores
// as a side effect of processing an embedding_jobs row, and embedding_jobs
// is only ever enqueued at message-creation (or task-checkbox-edit) time
// (search/embeddingQueue.js's enqueueEmbeddingJob, called from
// routes/messages.js and ws/server.js). Every message that already had its
// embedding computed *before* the sentiment feature shipped had its
// embedding_jobs row processed and deleted long ago — there is nothing left
// in that queue for the new code to act on, so those messages would
// otherwise stay unscored forever. Confirmed directly against the real
// database before writing this: 87/87 messages already embedded, 0 with a
// sentiment score.
//
// No re-embedding needed: every affected message already has a row in
// message_embeddings. This computes the score set-based, entirely in SQL,
// via pgvector's `<=>` cosine-distance operator (the same trick
// routes/search.js's own `similarity` field already uses) — the only two
// LLM-adapter calls this script ever makes are the positive/negative anchor
// embeddings themselves (search/sentimentService.js's own module-level
// cache is bypassed here on purpose, since a short-lived script process
// gains nothing from caching across calls it only ever makes once each).
//
// Every backend/src import is a dynamic `await import(...)` inside main(),
// after dotenv.config() has already populated process.env — a static
// top-level import would evaluate backend/src/config.js (which throws if
// PGHOST/PGDATABASE/etc. aren't already set) before dotenv.config() below
// ever runs, since ES module imports are hoisted above all other top-level
// code. Documented the hard way in this repo — see
// scripts/seed-demo-tv-workspace.mjs's own identical comment.
//
// Wired into scripts/airgap-upgrade.sh's own Phase G (RUNBOOK.md's
// "Enclave Upgrade" section) so every future upgrade re-runs this
// automatically, not just this one session's manual fix — safe to do
// unconditionally because it's idempotent: the count check below makes a
// no-op run (every future upgrade, once this backfill has already caught
// up) cheap and adapter-call-free, rather than re-embedding the same two
// anchor phrases forever for nothing.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

async function main() {
  const { db } = await import('../backend/src/db.js');
  const { config } = await import('../backend/src/config.js');
  const { embedText, toVectorLiteral } = await import('../backend/src/search/embeddingService.js');

  try {
    const { count: beforeCount } = await db('message_sentiment_scores').count('message_id as count').first();
    const { count: totalEmbedded } = await db('message_embeddings').count('message_id as count').first();
    console.log(`message_embeddings: ${totalEmbedded} rows. message_sentiment_scores: ${beforeCount} rows before this run.`);

    const { count: pendingCount } = await db('message_embeddings as me')
      .leftJoin('message_sentiment_scores as mss', 'mss.message_id', 'me.message_id')
      .whereNull('mss.message_id')
      .count('me.message_id as count')
      .first();
    if (Number(pendingCount) === 0) {
      console.log('Nothing to backfill — every embedded message already has a sentiment score.');
      return;
    }
    console.log(`${pendingCount} message(s) need a sentiment score.`);

    console.log('Embedding the positive/negative anchor phrases (two adapter calls, once each)...');
    // Sequential, not Promise.all: config.embedding.maxConcurrentRequests
    // defaults to 1, and the gate (search/embeddingConcurrencyGate.js)
    // rejects outright when at capacity rather than queuing — two
    // concurrent calls here would race the gate for no benefit.
    const positiveEmbedding = await embedText(db, config.sentiment.positiveAnchors);
    const negativeEmbedding = await embedText(db, config.sentiment.negativeAnchors);
    const positiveLiteral = toVectorLiteral(positiveEmbedding);
    const negativeLiteral = toVectorLiteral(negativeEmbedding);

    // Set-based: every message_embeddings row with no corresponding
    // message_sentiment_scores row gets one, computed directly from its
    // already-stored vector. `1 - (embedding <=> anchor)` converts
    // pgvector's cosine *distance* to cosine *similarity*, the same
    // conversion routes/search.js's own `similarity` field already uses.
    const result = await db.raw(
      `INSERT INTO message_sentiment_scores (message_id, score, model)
       SELECT
         me.message_id,
         (1 - (me.embedding <=> ?::vector)) - (1 - (me.embedding <=> ?::vector)) AS score,
         ? AS model
       FROM message_embeddings me
       LEFT JOIN message_sentiment_scores mss ON mss.message_id = me.message_id
       WHERE mss.message_id IS NULL
       RETURNING message_id`,
      [positiveLiteral, negativeLiteral, config.embedding.model],
    );

    console.log(`Backfilled ${result.rows.length} message(s) that already had an embedding but no sentiment score.`);

    const { count: afterCount } = await db('message_sentiment_scores').count('message_id as count').first();
    console.log(`message_sentiment_scores: ${afterCount} rows after this run.`);
  } finally {
    await db.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('backfill-sentiment-scores failed to run:', err.message || err);
    process.exit(2);
  });
