# 2026-07-26 Code Efficiency Review

Prompt: `docs/code-review-prompts.md` -> Code Efficiency / Simplicity Review.

Scope reviewed from current source: backend route/query patterns, worker queue logic, frontend state/component structure, shared primitives, and repeated operational script logic.

## Findings

### Low: message-list reply counts duplicate work that can be batched

The message list route calculates `reply_count` with a correlated subquery in the select list (`backend/src/routes/messages.js:54-75`). The code is simple and indexed, but it repeats the same child-count operation independently for every row in the page.

Batching this into a grouped count over the page’s message IDs would keep the response shape unchanged while making the query plan less repetitive.

### Low: completed side-effect job rows are retained indefinitely

The message side-effect worker intentionally updates successful jobs to `status = 'completed'` and keeps them forever (`backend/src/workers/messageSideEffectsWorker.js:164-178`). That avoids re-enqueue ambiguity, but it also means the table grows with message volume.

If the durable existence signal is only needed while repair/reconciliation is possible, add a compaction rule. If it is meant as long-term ledger data, document that explicitly and include it in backup/retention sizing.

### Low: `ChatShell.jsx` carries too many app responsibilities

`ChatShellInner` owns workspace/org selection, channel lists, messages, threads, direct messages, notifications, multiple admin panels, task dashboard state, digest state, and knowledge explorer state in one component (`frontend/src/components/ChatShell.jsx:103-173`). At 1,281 lines, it is still harder to reason about than the rest of the frontend.

The code has already extracted several leaf panels and primitives; the next efficiency gain is extracting stateful hooks or containers around message reconciliation, selection/navigation, and modal/panel routing.

## Verified Non-Issues

- The old per-render menu-navigation allocation was addressed: `nextHighlightedIndex()` now uses a simple enabled-index loop and has isolated tests.
- `fetchAllPages()` is intentionally used only for UI surfaces that need complete navigational lists; each server page remains bounded (`frontend/src/api/client.js:105-119`).
- Installer and upgrade scripts duplicate some phases deliberately to preserve separately verified, standalone operational paths (`scripts/airgap-upgrade.sh:14-21`).
