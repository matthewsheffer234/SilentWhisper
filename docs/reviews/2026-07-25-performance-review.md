# Application Performance Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
100-user readiness assessment: **Mostly ready for the stated single-instance target, with AI queue and query-shape caveats**. The database pool is sized for multiplexing, high-frequency message and embedding paths have appropriate indexes, WebSocket broadcast serializes payloads once per fan-out, and message side effects have moved off the send path.

The largest remaining risk is scarce LLM capacity: queued AI requests do not observe client disconnects until after they receive a slot. A lower-grade feed query issue remains in the message list, where reply counts are computed as a correlated subquery per returned row.

---

## Findings Matrix

| Severity | Domain | Finding / Bottleneck | Location |
|---|---|---|---|
| Medium | AI Queueing | Queued AI requests cannot be removed on client abort | `backend/src/llm/concurrencyGate.js:33` |
| Low | Database Query Shape | Message feed uses per-row correlated reply-count subquery | `backend/src/routes/messages.js:72` |
| Low | Worker Throughput | Embedding and side-effect workers process claimed batches serially | `backend/src/search/embeddingWorker.js:109` |

---

## Detailed Findings & Remediations

### [PERF-01] Abandoned AI Requests Can Consume Future LLM Slots
- **Severity**: Medium
- **Domain**: AI Queueing
- **Location**: `backend/src/llm/concurrencyGate.js:L33-L46`, `backend/src/llm/aiService.js:L67-L76`
- **Impact & Bottleneck Scenario**: The queue stores pending resolver functions with no abort signal. If a user navigates away while waiting, that request remains in FIFO order and later consumes one of the few `LLM_MAX_CONCURRENT_REQUESTS` slots. On CPU-only Ollama this can create seconds of wasted generation time.
- **Recommended Remediation**:
  ```js
  await acquireSlot(settings.maxConcurrentRequests, {
    signal,
    onQueued: (position) => {
      setCompletionHeaders();
      res.setHeader('X-Ai-Queue-Position', String(position));
      res.flushHeaders();
    },
  });
  ```

### [PERF-02] Reply Counts Are Recomputed Per Message Row
- **Severity**: Low
- **Domain**: Database Query Shape
- **Location**: `backend/src/routes/messages.js:L54-L75`
- **Impact & Bottleneck Scenario**: The channel feed selects up to a page of messages and computes `reply_count` through a correlated subquery for each row. The partial index on `parent_message_id` helps, but this still creates one lookup per result row. Under repeated scrolling in active channels, a grouped pre-aggregation is more predictable.
- **Recommended Remediation**:
  ```js
  const replyCounts = db('messages')
    .select('parent_message_id')
    .count('* as reply_count')
    .whereNotNull('parent_message_id')
    .groupBy('parent_message_id')
    .as('reply_counts');

  const rows = await query
    .leftJoin(replyCounts, 'reply_counts.parent_message_id', 'messages.id')
    .select(db.raw('coalesce(reply_counts.reply_count, 0)::int as reply_count'));
  ```

### [PERF-03] Worker Batches Are Claimed In Batches But Processed Serially
- **Severity**: Low
- **Domain**: Background Processing
- **Location**: `backend/src/search/embeddingWorker.js:L103-L117`, `backend/src/workers/messageSideEffectsWorker.js:L173-L185`
- **Impact & Bottleneck Scenario**: Both workers claim a batch using `SKIP LOCKED`, then process each job sequentially. This is conservative and resource-friendly, but it means a slow embedding or notification path can delay every later job in the same claimed batch.
- **Recommended Remediation**:
  ```js
  const concurrency = Math.min(config.embedding.maxConcurrentRequests, jobs.length);
  await runPool(jobs, concurrency, (job) => processJob(db, job));
  ```

## Architectural Wins & Verified Optimizations
- PostgreSQL pool defaults are `min: 2, max: 20`, matching the single-instance target (`backend/src/config.js:64`).
- High-frequency indexes exist for channel message pagination, threading, HNSW vector search, task scans, and analytics windows.
- WebSocket room broadcasts stringify once per event before fan-out (`backend/src/ws/connectionRegistry.js:67`).
- Message side effects and embeddings are durable queued work rather than inline message-send work.
