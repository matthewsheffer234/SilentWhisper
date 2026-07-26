# 2026-07-26 Performance Review

Prompt: `docs/code-review-prompts.md` -> Performance & Scalability Deep Dive.

Scope reviewed from current source: message/search/entity/AI routes, workers and queues, database indexes, WebSocket registry/presence code, frontend list loading/rendering, and enclave scripts.

## Findings

### Low: reply counts are calculated with one indexed lookup per returned message

`GET /api/channels/:channelId/messages` joins users, orders by creation time, and then selects `reply_count` via a correlated subquery per message (`backend/src/routes/messages.js:54-75`). Migration `0004` provides `idx_messages_threading`, so each lookup should be index-backed, but the query still scales with page size and channel activity as repeated child-count probes.

This is acceptable for the current page limits, but it is the most obvious read-path inefficiency left in the message feed. A grouped `count(*) where parent_message_id in (...)` CTE joined back to the page, or a maintained counter, would reduce repeated index traversal on busy channels.

### Low: completed message side-effect jobs have no retention or compaction policy

`message_side_effect_jobs` rows are intentionally marked `completed` rather than deleted so the system can remember which notification/entity-link side effects already ran (`backend/src/workers/messageSideEffectsWorker.js:164-178`). The code also states there is no cleanup pass yet, and that growth matches message volume.

The pending-claim query is protected by `idx_message_side_effect_jobs_status`, so this is not an immediate worker hot-path issue. It is still a storage and index-bloat risk over long-lived deployments because every message can leave persistent side-effect rows. Add a retention decision such as compacting old completed rows after reconciliation no longer needs per-message existence, or document that the table is intentionally part of the durable message ledger.

### Low: `ChatShell.jsx` remains a broad render/state coordinator

`frontend/src/components/ChatShell.jsx` is 1,281 lines and owns the app’s core workspace/channel/message/thread/admin/modal state (`frontend/src/components/ChatShell.jsx:103-173`). Presence has already been moved out to a context, and virtual scrolling exists, but this component still remains the highest-risk frontend render coordinator.

The practical risk is regressions and unnecessary re-render coupling when future features add more state. Continue extracting cohesive state domains, especially message/thread reconciliation, modal orchestration, and workspace/channel selection.

## Verified Improvements

- Backend list endpoints use bounded pagination, and frontend navigation lists use `fetchAllPages()` with incremental `onPage` rendering (`frontend/src/api/client.js:105-119`).
- Long channel histories have a committed E2E virtual-scrolling check (`frontend/e2e/workflows.spec.js:2436-2480`).
- WebSocket broadcast stringifies once per frame and connection registry operations are map/set based.
- AI work is bounded by per-user rate limits, global concurrency, and queue depth.
- vLLM installer checks include real model presence, streaming parse, embedding dimension, and direct concurrency/latency probes (`scripts/airgap-install.sh:233-375`).
