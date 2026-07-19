# Feature Requests — Running Plan

A living backlog of feature ideas for Silent Whisper. This is a planning document, not an implementation log — see `PROJECT_PLAN.md` Section 11 for what's actually been built.

## How this document is maintained

- Whenever a new feature is requested, a design is thought through (what changes, where, how it fits the existing authorization/audit/rate-limiting conventions in `PROJECT_PLAN.md`) and added below as its own entry, in the format under "Entry format."
- After each addition, every entry is re-ranked by utility and implementation dependency — most useful first unless a prerequisite should land earlier. Rank changes are expected over time as the app's shape changes; nothing here is permanent.
- An entry moves to **Done** (with a pointer to the `PROJECT_PLAN.md` Section 11 log entry that implemented it) once it ships, rather than being deleted — keeps the history of what was considered and why.
- Nothing in this document is authorization to build it. Design-only until explicitly requested.

## Entry format

```
### N. Title

**Status**: Proposed | Planned | Done
**Utility**: one line on why this matters / who it's for
**Origin**: how this came up (a request, a gap found during other work, etc.)

Design: what changes, where, how it's authorized/audited/tested, matching
existing PROJECT_PLAN.md conventions. Enough detail that implementation is
a matter of execution, not re-deciding the approach.
```

---

## Ranked backlog

### 1. Bound the AI task-extraction thread scan

**Status**: Proposed
**Utility**: The single Node process serving all 100 concurrent users can be measurably slowed by one unbounded query on every call; capping it protects the availability invariant `PROJECT_PLAN.md` Section 2 sets, not just one endpoint's own response time.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 1 (High).

Design:
- `POST /api/messages/:messageId/ai/extract-tasks` (`backend/src/routes/ai.js`) currently loads every reply to a thread's root message with no `LIMIT` before `LLM_MAX_INPUT_CHARS` truncation ever runs — unlike the summarize route's own bounded query a few lines above it in the same file, and unlike `GET /channels/:channelId/messages`. Cap the SQL read itself to the most recent `MAX_THREAD_AI_MESSAGES` (200) replies, restoring chronological order via a subquery (`ORDER BY created_at DESC LIMIT N`, wrapped and re-sorted ascending) — the same shape `GET /channels/:channelId/messages` already uses.
- Add a cheap `count(*)` only if the audit payload should carry an `omittedReplyCount`; never materialize every row just to learn the total.
- No schema/authz change — membership gating is unaffected.
- Tests: a thread with more than `MAX_THREAD_AI_MESSAGES` replies still extracts tasks correctly from the most recent N in chronological order; confirm the SQL query itself is `LIMIT`-bounded (via a query-builder spy or `EXPLAIN`), not just that truncation happens after the full read.

### 2. Bound the workspace digest's mention scan

**Status**: Proposed
**Utility**: Same availability invariant as above — a two-week-old mention backlog (`AI_DIGEST_MAX_WINDOW_HOURS` defaults to 336 hours) should never force a full unbounded scan before `DIGEST_MAX_TOTAL_MESSAGES` caps the result the caller actually sees.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 2 (High).

Design:
- `selectMentionMessages()` (`backend/src/services/workspaceDigestService.js`) fetches every unread, non-dismissed mention in the requested window with no `.limit()`, unlike its sibling `selectChannelMessages()`, which already bounds itself to `DIGEST_MAX_MESSAGES_PER_CHANNEL` per channel. Give `selectMentionMessages()` the same treatment: push `DIGEST_MAX_TOTAL_MESSAGES` into the SQL boundary via an ordered/limited subquery, re-sorted chronologically, rather than capping only after `Promise.all`/dedup/sort has already run over the full pre-cap row count.
- Keep a separate cheap `count(*)` for the `mentionCount` field already in the `AI_WORKSPACE_DIGEST_REQUESTED` audit payload, instead of deriving it from the full materialized array.
- No authz change.
- Tests: a user with more unread mentions than `DIGEST_MAX_TOTAL_MESSAGES` still gets a correctly-capped, chronologically-ordered digest; confirm the mention query itself is `LIMIT`-bounded.

### 3. Make audit-chain verification non-blocking

**Status**: Proposed
**Utility**: `POST /api/audit/verify` currently reads the entire `audit_logs` table and hashes every row synchronously with no yield point, inside the same single Node process serving every REST/WebSocket call for all 100 users — a routine, authorized admin action becomes a full-stack availability incident once the table grows past low tens of thousands of rows, and `audit_logs` is append-only with no retention/deletion path.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 3 (High).

Design:
- `verifyAuditChain()` (`backend/src/audit/auditService.js`) moves from one unbounded `SELECT` plus a synchronous `for` loop to batched reads (`WHERE id > lastId ORDER BY id LIMIT batchSize`, batch size ~5000) with a cooperative yield (`await new Promise(resolve => setImmediate(resolve))`) between batches, so the event loop can service other requests between chunks. This is the minimal fix, requiring no new infrastructure.
- Stronger option, worth considering if batching still shows measurable latency under load testing before committing to it (meaningfully more implementation work): move verification into a `worker_thread`, or invoke the already-separate `scripts/verify-audit-log.mjs` CLI logic as a genuinely separate process from the route handler, so a large table's cost never touches the request-serving thread at all.
- No change to verification semantics or response shape — same early-return-on-first-broken-link contract, same system-admin-only gate, no rate limit added or needed since this is an authorized-admin-only, already-infrequent action.
- Tests: verification still detects a tampered row correctly under the batched implementation; a synthetic large table (tens of thousands of rows) confirms the event loop actually yields between batches — e.g., a concurrent lightweight request or timer observably completes mid-verification rather than queuing behind it.

### 4. Stop leaking workspace member email addresses via members-search

**Status**: Proposed
**Utility**: Any authenticated plain workspace member — no `MANAGE_MEMBERS` or admin privilege required — can currently harvest every other member's email address through `members-search`, contradicting that endpoint's own in-code justification for its loose gate and diverging from its org-scoped sibling, which already gets this right. Real, currently-exploitable PII exposure, not a theoretical gap.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 7 (Medium).

Design:
- `GET /api/workspaces/:workspaceId/members-search` (`backend/src/routes/workspaces.js`) drops `users.email` from its select/response, matching `GET /api/organizations/:orgId/members-search`'s already-correct shape (`id`/`username`/`displayName` only — fields already visible through message authorship/mentions elsewhere).
- `frontend/src/components/PeoplePicker.jsx` (around line 322) currently renders `person.email` for results sourced from this endpoint; fall back to `username`/`displayName` there, confirming during implementation which pickers are wired to `members-search` versus the tighter, still-email-capable `people-search` before changing rendering.
- No new audit event needed — this narrows an existing response shape without changing who can call the route.
- Tests: `members-search` response no longer contains an `email` field for any result, for a plain-member caller; a contract test on the response shape so a future change can't silently reintroduce the field; a frontend test confirming `PeoplePicker` renders correctly without `person.email` when backed by this endpoint.

### 5. Recheck account status when rotating a refresh token

**Status**: Proposed
**Utility**: Every other credential-issuing path (login, WebSocket re-authenticate) rechecks `users.status === 'ACTIVE'` before granting a session; `POST /api/auth/refresh` is the one exception. Not currently reachable given the app's single disable code path (which already revokes refresh tokens), but a defense-in-depth gap in an otherwise consistently-enforced invariant, cheap to close.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 8 (Medium).

Design:
- `POST /api/auth/refresh` (`backend/src/routes/auth.js`) re-fetches the user filtered on `status: 'ACTIVE'` in the same lookup used to build the response, rather than an unfiltered lookup by id alone. If the filtered lookup returns nothing, revoke all refresh tokens for that user id, clear the refresh cookie, and respond `401` with the same generic "Invalid refresh token" message used elsewhere, matching login's existing handling rather than introducing a new error shape.
- No schema change. No new audit event type — the existing `AUTH_TOKEN_REFRESH` event simply stops firing on the now-rejected path.
- Tests: disable a user while a live, unexpired refresh token exists (isolating this check from the normal disable path's own token revocation); confirm `/api/auth/refresh` 401s, clears the refresh cookie, and issues no access token.

### 6. Minimal CI workflow

**Status**: Proposed
**Utility**: `ARCHITECTURE_REVIEW_(Claude).md` calls this "the single cheapest fix on this list" (P0 Recommendation 1) — nothing currently gates a broken build or a failing test from reaching `main`. Confirmed still true: no `.github/workflows` directory exists at all. This is the complementary half of "the deploy loop" entry (already shipped): that entry stops a *stale* container from being deployed; this stops a *broken* one from ever being deployable in the first place.
**Origin**: `ARCHITECTURE_REVIEW_(Claude).md` P0 Recommendation 1 (2026-07-17), re-confirmed against the live repo on 2026-07-18.

Design:
- New `.github/workflows/ci.yml`, triggered on every push to `main` and every pull request targeting it. Two independent jobs so a frontend-only or backend-only PR isn't blocked waiting on the other:
  - **`backend`**: a `postgres` service container (`pgvector/pgvector:pg16`, matching `docker-compose.yml`'s own image choice so `CREATE EXTENSION vector` works — plain `postgres:16-alpine` would fail migration `0009`), `POSTGRES_DB: silent_whisper_test` directly (no separate create-database step needed). Steps: checkout, `actions/setup-node@v4` (node 20, matching every `Dockerfile`'s `FROM node:20-alpine`), `npm ci` in `backend/`, `npm run migrate` (creates the schema *and* the `app_runtime_user` role — see `database/migrations/0007_grants.js`), `npm test`.
  - **`frontend`**: checkout, setup-node, `npm ci` in `frontend/`, `npm run test:unit`, `npm run build`.
  - **Deliberately out of scope**: `frontend/e2e` (Playwright) — needs a live Ollama instance, real Docker Compose stack, cached browser binaries, and careful rate-limiter batching (`RUNBOOK.md`'s Integration Tests section documents exactly why a single unbatched run 429s). That's a meaningfully bigger lift than "run the existing unit/integration suites," and Claude review's own P0 framing only ever asked for `npm test`/`npm run test:unit`/`npm run build` — e2e-in-CI is a separate future entry if wanted, not bundled into this one.
- **Env vars for the `backend` job** (`PGHOST: localhost`, `PGPORT: 5432`, `PGUSER`/`PGPASSWORD` matching the service container's admin credentials, `PGDATABASE: silent_whisper_test`, `APP_DB_USER`, `APP_DB_PASSWORD`, `JWT_SECRET`) come from **GitHub Actions repository secrets** (`secrets.CI_PGPASSWORD`, `secrets.CI_APP_DB_PASSWORD`, `secrets.CI_JWT_SECRET`), not literals in the workflow file — `PROJECT_PLAN.md` Section 3 says exactly this for any future CI secret ("reference secrets only as repository secrets... never embed raw values in workflow YAML or IaC templates") with no carve-out for "it's only a throwaway CI database," so this follows that literally rather than deciding it's a special case. These three repository secrets need to be added once (any generated value works — nothing in the ephemeral CI Postgres container persists or is reachable outside that one workflow run) before the workflow can pass.
- **No schema/authz/audit implications** — this is CI plumbing only, one new file (`.github/workflows/ci.yml`).
- **Tests**: none needed for the workflow file itself; its "test" is that it actually goes green on the PR that introduces it, and red on a PR that deliberately breaks a test (worth confirming once during implementation, then reverting the deliberate break).

### 7. Cancel summarize/extract-tasks on client disconnect

**Status**: Proposed
**Utility**: `LLM_MAX_CONCURRENT_REQUESTS` defaults to 1, and `PROJECT_PLAN.md`/`config.js` both call this deliberate on the CPU-only Ollama test environment. A closed tab or superseded retry currently holds that sole slot for up to `LLM_TIMEOUT_MS` (30s) regardless, queuing every other concurrent user's summarize/extract-tasks call behind a dead connection — the one AI feature the design explicitly flags as capacity-constrained.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 4 (Medium).

Design:
- `POST /channels/:channelId/ai/summarize` and `POST /messages/:messageId/ai/extract-tasks` (`backend/src/routes/ai.js`) wire the same `res.on('close', () => controller.abort())` → `AbortController` → `signal` pattern already shipped and proven on `POST /ai/workspace-digest`, passing `signal` through to `runStreamingCompletion()`.
- No behavior change for the normal (non-disconnected) path. No new audit event; existing `AI_SUMMARY_REQUESTED`/`AI_TASK_EXTRACT_REQUESTED` events are unaffected.
- Tests: mirror the digest route's existing disconnect-cancellation test for both summarize and extract-tasks — a simulated client disconnect mid-stream releases the concurrency slot promptly rather than holding it to timeout, verified by a second queued request completing sooner than `LLM_TIMEOUT_MS` after the first client disconnects.

### 8. Paginate the remaining unbounded roster/list endpoints

**Status**: Proposed
**Utility**: Message history and the admin user/workspace rosters are already cursor/offset-bounded; several other list routes called on ordinary page loads (workspace sidebar, channel list, DM list) still return every matching row regardless of how large the caller's history has grown, which the 100-concurrent-user target does nothing to cap.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 6 (Medium).

Design:
- Extend the existing `parseOffsetPagination`/`parsePagination` helpers (`backend/src/validation.js`) to: `GET /api/direct-messages`, `GET /api/organizations`, `GET /api/organizations/:orgId/members`, `GET /api/workspaces/:workspaceId/members`, `GET /api/workspaces/:workspaceId/channels` (also replacing its per-row correlated `COUNT(*)` member-count subquery with a single pre-aggregated join, still paginating the outer channel rows), and `GET /api/workspaces/:workspaceId/channels/:channelId/members` — following the exact precedent `GET /admin/users`/`GET /workspaces/admin/all` already set (`{items, total, limit, offset}` response shape).
- Separately, `markAllMentionNotificationsRead()` (`backend/src/services/mentionNotificationService.js`) changes from select-every-matching-id-then-`UPDATE ... WHERE id IN (...)` to a single set-based `UPDATE ... WHERE ... RETURNING id`, with the channel-membership check expressed as an inline `whereExists` rather than a separately materialized id array.
- Frontend call sites for each paginated route need matching pager/cursor UI or "load more" affordances wherever the current UI assumes a complete list (sidebar, channel list, member list); scope this per-route during implementation rather than assuming one shared UI pattern fits all six.
- No authz change — pagination doesn't alter who can see what, only how much comes back per call.
- Tests: each updated route rejects malformed pagination params consistently with the existing admin routes' behavior and returns the correct bounded page; a regression test confirms `markAllMentionNotificationsRead` still only touches notifications the caller can actually see (channel membership still enforced) under the new single-statement form.

### 9. Unpredictable per-request nonces in LLM prompt delimiters

**Status**: Proposed
**Utility**: Defense-in-depth against prompt injection: every prompt builder currently delimits untrusted message content with fixed, guessable marker strings (`MESSAGES_START`/`MESSAGES_END`, `THREAD_START`/`THREAD_END`), visible in the codebase and therefore spoofable by a message containing the literal marker text. AI output already renders to other users as a trusted-looking summary/task list, so a successful spoof is a misleading-content vector, not classic XSS — the frontend renders AI output as plain text, never HTML.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 5 (Medium).

Design:
- `backend/src/llm/promptTemplates.js`'s prompt builders generate a random per-request nonce (`crypto.randomBytes(12).toString('hex')`) and use it in the marker names (`${kind}_START_${nonce}`/`${kind}_END_${nonce}`) instead of fixed strings, with the instruction text telling the model that only content between that exact nonce pair is data.
- Serialize the delimited message content as JSON (username/content pairs) rather than raw interpolated text, so structural characters are escaped rather than relying purely on marker-avoidance — this also removes ambiguity from literal newlines/markdown in message content confusing the model about block boundaries.
- No schema/authz/audit change — this is prompt-construction only. Bump `LLM_SUMMARY_PROMPT_VERSION`/`LLM_TASK_PROMPT_VERSION`/`llm.digest_prompt_version` per this codebase's existing convention for any prompt-shape change, so historical audit rows stay attributable to the prompt version that generated them.
- Tests: a message containing a literal (guessed or copy-pasted) marker string no longer breaks out of the data block, verified against a fixture; prompt-builder unit tests confirm the nonce changes per call and the JSON body round-trips correctly for messages containing markdown/newlines/quotes.

### 10. Serialize DM creation to prevent duplicate-channel races

**Status**: Proposed
**Utility**: Two people clicking "Message" on each other in the same window (a plausible UI interaction — e.g. both opening each other's profile from a shared roster at once) can each pass `POST /api/direct-messages`'s "no existing channel" check under Postgres's default `READ COMMITTED` isolation and create two separate DIRECT channels for the same pair — the endpoint's own "creates or reuses" contract silently fails at exactly the concurrency level this app targets.
**Origin**: `docs/reviews/security-performance-review-2026-07-19.md` Finding 9 (Low).

Design:
- `POST /api/direct-messages` (`backend/src/routes/directMessages.js`) takes a `pg_advisory_xact_lock` keyed on the sorted pair of user ids (`hashtext('dm:{lo}:{hi}')`) before the existing-channel check inside its transaction, mirroring the pattern `auditService.js`'s hash-chain append and `invitations.js`'s accept route already use for their own race-prone paths — cheap, no table-wide lock, consistent with existing codebase conventions rather than a new concurrency-control style.
- Longer-term alternative, not required for this entry: a partial unique index over the DM shape if 1:1 DMs are ever normalized into their own table. The advisory lock is the minimal, schema-preserving fix.
- No authz/audit change.
- Tests: two concurrent `POST /api/direct-messages` calls for the same user pair resolve to the same channel id, with exactly one `created: true` response; existing single-caller behavior is unaffected.

### 11. Channel attention and health views

**Status**: Proposed
**Utility**: Notification counts tell users that something happened; attention views tell them what needs a response. This helps teams manage fast channels without relying on manual scanning.
**Origin**: User asked for innovative ideas from modern similar applications (2026-07-18), extending Slack/Teams-style catch-up and activity surfaces into a local, project-focused dashboard.

Design:
- Add a workspace-level "Attention" view in `WorkspaceHome.jsx` or the notification panel, grouping actionable conversation states: mentions not read, threads with no reply after N hours, questions that appear unanswered, assigned action items, recent decisions, and AI-detected blockers.
- Start with deterministic signals already available: unread mention notifications, open action items, recent thread replies, and channels with recent activity since the user's last visit if read-state exists or is added. AI-detected questions/blockers can be a later enhancement behind the existing AI rate/concurrency controls.
- This likely needs a `user_channel_read_state` or `user_conversation_state` table if the product wants true "since I last looked" behavior rather than coarse recent windows. Server time remains authoritative.
- UI should be a dense triage list, not a marketing-style digest: rows show source, age, why it needs attention, and a direct open action. Let users dismiss/mark resolved where appropriate.
- Authorization: every row must be generated only from channels/messages the caller can read; private-channel metadata should not leak through row counts.
- Audit: ordinary read/dismiss state does not need high-volume audit logging unless it becomes admin-visible. AI-generated blocker/question extraction should be audited like other AI actions with counts and prompt versions only.
- Tests: read-state isolation, private-channel filtering, deterministic attention row generation, dismiss/resolve behavior, and e2e for opening an attention row into the right channel/thread.

### 12. Entity pages as a lightweight knowledge base

**Status**: Proposed
**Utility**: The existing `[[Entity Name]]` registry can become more than backlinks: it can be Silent Whisper's local knowledge graph for projects, customers, systems, incidents, and decisions.
**Origin**: User asked for innovative ideas from modern similar applications (2026-07-18), building on the already-shipped double-bracket entity registry and entity detail pages.

Design:
- Extend `entities` with editable metadata: description, aliases, owner/steward user id, status, tags, and optional external/local reference fields. Keep metadata workspace-scoped and never global across organizations.
- Add `entity_relationships` (`source_entity_id`, `target_entity_id`, relationship type) for "depends on", "owned by", "related to", etc. Relationship writes require workspace membership and appropriate edit permission.
- Entity detail pages should show recent references, linked decisions/action items, related entities, and pinned messages. Can surface the already-shipped "Inline Markdown checkbox tasks" entry's (Done section) owner-tagged tasks as linked action items.
- AI can generate a "What we know" summary from authorized references, clearly labeled with source citations and last-generated time. Store generated summaries as revisions or cached snapshots with prompt version/provider metadata, not as unquestioned canonical truth.
- Authorization: references and generated summaries must be computed only from channels the caller can read. If entity metadata is workspace-wide but some references are private, the metadata can show while private references remain hidden.
- Audit: `ENTITY_METADATA_UPDATED`, `ENTITY_RELATIONSHIP_CREATED`, `ENTITY_RELATIONSHIP_REMOVED`, and `AI_ENTITY_SUMMARY_REQUESTED`.
- Tests: metadata editing, alias normalization/collision behavior, relationship isolation across workspaces, private-reference filtering, and frontend e2e for editing an entity and navigating related context.

## Done

### Inline Markdown checkbox tasks with a workspace task dashboard

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Inline Markdown checkbox tasks with a workspace task dashboard" (2026-07-19).

Obsidian-style inline checkboxes (`- [ ] text [owner:: @username]`) typed directly into a normal message, tokenized deterministically — no model call, no review-before-commit step, no persistence beyond `messages.content` itself. New `backend/src/services/taskParser.js` (`parseTasks`/`setTaskChecked`) is the one canonical tokenizer; `frontend/src/markdown.jsx` mirrors it line for line, and `docs/task-tokenizer-fixtures.json` is run through both sides' own implementation (`taskParser.test.js`/`markdown.test.jsx`) as the guardrail against the two drifting apart. One terminology change from the originally submitted spec, decided before implementation: the field is `owner`, not `assignee`, everywhere — internal field name, audit vocabulary, dashboard copy ("Tasks for Me"/"Tasks for Everyone Else"). The Markdown token's *key* itself (`[owner:: @user]` by default) is a separately configurable alias (`TASK_OWNER_TOKEN_ALIAS`/`VITE_TASK_OWNER_TOKEN_ALIAS`, validated at backend startup since it's compiled into a `RegExp`) — a deployment can rename the bracket syntax without a code change, independent of what the parsed field is called.

New `PATCH /api/channels/:channelId/messages/:messageId/tasks/:taskIndex` (`{checked: true|false}`, an explicit target state rather than an implied toggle) is the first intentional post-create mutation of `messages.content`. Row-locked (`FOR UPDATE`) inside a transaction, confirms `channelId`/`messageId` actually belong together (existence-hiding 404 otherwise, the same pattern the cross-workspace channel-member-injection fix established), broadcasts `message_updated` via the existing `broadcastToRoom`, and is audited as `MESSAGE_TASK_TOGGLED` with ids/counts only. Re-enqueues an embedding refresh (so semantic search doesn't keep serving the pre-toggle vector) but deliberately leaves entity linking and mention notifications alone — a checkbox flip can't add/remove a `[[Entity]]` token, and shouldn't re-notify anyone. New `GET /api/workspaces/:workspaceId/tasks` (`?windowDays=&cursor=&limit=`) is a bounded, `channel_members`-scoped rolling-window query (default 30 days, `TASK_DASHBOARD_WINDOW_DAYS`) backed by a new `pg_trgm` GIN index on `messages.content` (migration `0021_task_dashboard_index.js`) — the SQL only narrows LIKE candidates, `parseTasks()` always does the real tokenization server-side. DMs/group DMs are excluded by construction (no `workspace_id`), not by an extra check.

Frontend: `markdown.jsx` gained a line-first rendering pass (before the existing link/bold/italic/entity/mention passes, since checkbox syntax is line-anchored) that recursively runs each task line's description back through the rest of the pipeline, so `[[Entity]]`/`@mention`/bold/italic still work inside a task. Checkbox hit target is 44×44px, matching `ChannelView.jsx`'s existing `detailsButton` precedent. `ChatShell.jsx` gained a real `message_updated` WS handler reconciling `messagesByChannel`, an open thread, and a newly-lifted `workspaceTasks` list together, so a toggle from any one surface (channel view, thread, or the dashboard) live-updates the others without a reload — verified directly with two concurrent browser sessions. `WorkspaceHome.jsx` gained the "Tasks for Me"/"Tasks for Everyone Else" segmented dashboard with loading/error/empty states, prefetched on workspace switch.

Verified end-to-end in a real browser (backend + frontend dev servers against the shared Postgres/Ollama containers, two concurrent logged-in sessions): sending checkbox lines, rendering with the correct checked/owner state, toggling from both the channel view and the dashboard, persistence surviving a reload, and live cross-pane WS reconciliation with no reload. One real, pre-existing, unrelated gap found during that verification: the message composer is a plain single-line `<input>` with no way to type a literal newline (Shift+Enter does nothing special) — multi-line checklists in a single message currently require pasting or building the list across sequential single-line messages; each still renders and toggles correctly. Not part of this entry's scope, but worth its own follow-up if multi-line composing is wanted.

Tests: `backend/tests/taskParser.test.js` (25 tests — pure tokenizer against the shared fixture file, plus `setTaskChecked` idempotency/out-of-range/negative-index behavior and the configurable owner-token-alias path); `backend/tests/messages.test.js` gained 10 toggle-endpoint tests (persistence, only-the-targeted-index-changes, explicit-target-state convergence, two genuinely concurrent toggles of the same message, non-member 404, cross-channel `channelId`/`messageId` mismatch 404, out-of-range `taskIndex` 404, non-boolean `checked` 400, the `MESSAGE_TASK_TOGGLED` audit row's ids-only payload, and archived-workspace rejection); new `backend/tests/taskDashboard.test.js` (12 tests — rolling-window bound, private-channel/cross-workspace/DM exclusion, a public channel the caller never joined staying invisible, pagination/cursor behavior, and malformed-query 400s); `frontend/src/markdown.test.jsx` gained 23 tests (15 shared-fixture-parity cases plus 8 covering rendering/callback behavior). 514/515 backend tests (one pre-existing, previously-documented `aiRoutes.test.js` audit-row race, reproduced identically on a clean `main` via `git stash` before this work began); 89/89 frontend unit tests; clean production build.

### Bounded AI concurrency queue instead of hard-rejecting

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Bounded AI concurrency queue instead of hard-rejecting" (2026-07-18).

`llm/concurrencyGate.js`'s synchronous `tryAcquire`/`release` pair became an async `acquireSlot(maxConcurrent, { onQueued })`/`release()`, backed by a bounded in-memory FIFO queue (`AI_QUEUE_MAX_DEPTH`, default 8, env-only). A request beyond `LLM_MAX_CONCURRENT_REQUESTS` now waits rather than being refused outright; `release()` transfers the freed slot directly to the next queued waiter instead of decrementing and letting a fresh caller race for it. Once the queue itself is full, a new arrival still gets the existing `503 "AI service is at capacity, please try again shortly"` immediately — this entry narrows *when* that fires, it doesn't remove it. `llm/aiService.js`'s `runStreamingCompletion` moves prompt construction (pure, local, no provider call) ahead of `acquireSlot` — a deliberate reordering from the design text — so every response header, including the new `X-Ai-Queue-Position` set and flushed the moment a request is queued, goes out in one flush regardless of whether the request ends up waiting; `setHeader()` after an early flush would otherwise throw. Frontend: `api/ai.js`'s `streamPost` reads `X-Ai-Queue-Position` (available as soon as `fetch()`'s promise resolves, well before the streamed body finishes) via a new `onQueued` callback threaded through `summarizeChannel`/`extractTasks`/`requestWorkspaceDigest`; `ChannelView.jsx`/`ThreadSidebar.jsx`/`WorkspaceDigestPanel.jsx` show a new `formatAiQueueLabel` ("Queued (position N)…") in place of "Running AI…"/"Generating…" while waiting, clearing back to the running label on the first streamed chunk.

Tests: `backend/tests/llmConcurrencyGate.test.js` rewritten for the async API (immediate grant, FIFO queuing/position numbering, queue-depth-exceeded rejection, release-with-nothing-queued); `backend/tests/aiRoutes.test.js` gains three end-to-end tests over the real HTTP routes (second request queues and completes after the first; a third/fourth queue and grant in strict FIFO order; an arrival at full queue depth still 503s immediately, auditing nothing) — building these surfaced that supertest/superagent's `Test` is lazy (constructing one without immediately awaiting it never sends the request over the wire), requiring an explicit `.end()`-based `fireNow` helper to get two requests genuinely in flight at once, and that draining several queued mocked-fetch calls at test end must happen one at a time as each is actually reached (a single `forEach` over whatever resolvers existed at one instant left later-queued requests permanently blocked). `frontend/src/aiPresentation.test.js` gains a case for `formatAiQueueLabel`. Verified: 467/468 backend tests pass (the one failure is the same pre-existing `aiRoutes.test.js` audit-row race documented in this section's "Hot path splitting" entry); 66/66 frontend unit tests; clean production build.

### Docker Compose restart policies, deeper `/health` checks, and paginated admin lists

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Restart policies, deeper health checks, and paginated admin lists" (2026-07-18). Three independent backlog entries (originally 2, 3, and 4) implemented together in one pass since none touch each other's code.

`restart: unless-stopped` added to `postgres`/`backend`/`silent-whisper-ollama`/`frontend` in `docker-compose.yml` (not `migrate`/`ollama-pull-model`, which are one-shot). New `GET /health/live` (pure liveness, no DB/provider touch) and an additive `ai` field on `GET /health` reusing `llm/healthCheck.js`'s already-cached sweep result — `ai.healthy: false` never flips `/health`'s own status/HTTP code. `GET /api/admin/users` and `GET /workspaces/admin/all` both gained `?limit=&offset=` (via a new shared `parseOffsetPagination` in `validation.js`) and now return `{users|workspaces, total, limit, offset}` instead of a bare array; `SystemAdminPanel.jsx` and its two API client functions updated to match, with a new prev/next `Pager` component ("Showing 1–50 of 340").

### Hot path splitting: async notification writes and entity linking

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Hot path splitting: async notification writes and entity linking" (2026-07-18). Before implementation, confirmed with the user that the resulting ~1s lag on mention notifications was acceptable, given the design's own text flagged this as a UX tradeoff needing direct sign-off rather than an assumption — both notification writing and entity linking moved to the worker, per that confirmation, rather than the "notifications stay sync" fallback also offered.

New migration `0020_message_side_effect_jobs.js`: `message_side_effect_jobs` (`message_id`, `job_type` — `NOTIFICATION` | `ENTITY_LINK` — composite primary key, `status`, `attempts`, `last_error`, timestamps), same `FOR UPDATE SKIP LOCKED`-polling shape as `embedding_jobs`, same grants. `routes/messages.js` and `ws/server.js`'s send paths both replaced their inline `extractMentionedUserIds`/`createMentionNotifications`/`linkMessageEntities`/mention-WS-push calls with a single `enqueueMessageSideEffectJobs(db, { messageId, workspaceId })` (new `services/messageSideEffectsQueue.js`) — a `NOTIFICATION` row is always enqueued, an `ENTITY_LINK` row only when `workspaceId` is truthy (DIRECT/GROUP_DM channels never had entity linking to begin with). New `workers/messageSideEffectsWorker.js`, structurally identical to `embeddingWorker.js`: polls on `MESSAGE_SIDE_EFFECTS_WORKER_INTERVAL_MS` (default 1s — tighter than embedding's 2s, since this feeds a user-visible notification rather than background search indexing), re-derives everything a job needs (message content, channel, workspace, sender identity) by joining `messages`/`channels`/`users` at process time rather than carrying payload columns, and — since the whole mention pipeline moved, not just the DB write — the real-time `mention` WS push (via `sendToUser`) now happens inside the worker's `NOTIFICATION` job processing, not synchronously at send time.

Three deliberate deviations from the original design text, each because the actual codebase precedent it was mirroring turned out to work differently than the design assumed:
- **No `processed_at` column, delete-on-success instead**: the design listed `processed_at` alongside `status`/`attempts`, but `embedding_jobs` — the explicitly-named template — has no such column and deletes its row on success, keeping the table free of an ever-growing "already processed" backlog. Followed `embedding_jobs`'s actual shape over the design text's `processed_at` mention.
- **No same-transaction enqueue**: the design called for the job-enqueue insert to share a transaction with the message insert. `enqueueEmbeddingJob` — the identical problem, already shipped — does not do this; it's a separate, try/catch-wrapped, best-effort insert immediately after, accepting a narrow crash window as a documented rare gap rather than a data-loss risk. Matched that precedent instead of introducing a new transactional pattern.
- **Retry/dead-letter tested via an intentionally unrecognized `job_type`, not a mocked failure**: unlike embedding jobs (which call an external provider, mockable via `global.fetch`), these jobs are pure DB work with nothing external to mock. `processJob` throws on any `job_type` other than `NOTIFICATION`/`ENTITY_LINK` — a real, deterministic error path (also useful defensively against future bad data) — and the tests insert a `'BOGUS'`-typed row directly to exercise retry/dead-letter without mocking anything.

**Tests**: new `backend/tests/messageSideEffectsWorker.test.js` (9 tests) — both job types process correctly (notification row + live WS push; entity + link created), a DM never gets an `ENTITY_LINK` job, retry increments `attempts` without dropping the job, dead-letter (`status='failed'`) once `maxAttempts` is exhausted and stays untouched afterward, batch-size cap, and — the direct proof the hot path no longer does this work inline — both REST and WS sends enqueue jobs (pending, unprocessed) with zero rows in `entities`/`mention_notifications` until a tick actually runs. Every pre-existing test that used to assert on notifications/entities immediately after a message send needed a `runMessageSideEffectsWorkerTick(db)` call added: `mentions.test.js` (6 tests), `mentionNotifications.test.js` (5 tests, one of which was the change that actually broke first), `entities.test.js` (fixed once, in its one shared `sendMessage` helper, covering all 14 tests in that file), and `aiWorkspaceDigest.test.js` (3 tests) — two of which (`aiWorkspaceDigest.test.js`'s "a read mention is excluded"/"outside the requested window" tests) had gone on quietly passing for the *wrong* reason (a `mention_notifications` row that no longer existed yet meant their `.update(...)` calls silently touched zero rows, producing the same "excluded" observable outcome the test expected, but no longer for the reason it claimed to test) — found and fixed alongside the one that actually failed, not left as a latent false-positive. WS-path tests needed a `pollUntil`-style helper (matching `embeddingIngestion.test.js`'s own established pattern) rather than a bare tick, since the WS handler broadcasts `message_created` before finishing the awaited enqueue call — a client seeing the broadcast proves nothing about whether the job row has landed yet.

**Verification**: 451 backend tests, 450 passing (the one failure the same pre-existing, previously-documented `aiRoutes.test.js` audit-row race). A "Cannot log after tests are done" / DB-pool-exhaustion warning appears in the full run's output; traced this down to confirm it is **not** caused by this change — it reproduces identically when pairing `ws.test.js` with `embeddingIngestion.test.js` (both pre-existing, untouched by this work), so it's latent cross-file test-infrastructure fragility exposed by the suite's growing size, not a regression here. Not independently verified: a live browser confirming the ~1s notification lag feels acceptable in practice — no browser/screenshot tool was available this session, so this rests on the backend test suite (which exercises real WebSocket connections and a real worker tick) plus the user's upfront confirmation of the tradeoff, not a manual UI check.

### The deploy loop: production frontend bundle + a scripted deploy step

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "The deploy loop: production frontend bundle + a scripted deploy step" (2026-07-18).

`frontend/Dockerfile` is now a multi-stage build — `node:20-alpine` runs `npm ci && npm run build`, then `nginx:alpine` serves the resulting `dist/` on port 3000 via a new `frontend/nginx.conf`: hashed `/assets/` files cached `immutable` for a year, everything else falling back to `index.html` (`Cache-Control: no-cache`) so React Router's `/invite/:token` route survives a hard refresh or a shared link. `VITE_API_URL`/`VITE_WS_URL` moved from `docker-compose.yml`'s `frontend.environment` to `frontend.build.args`, since Vite bakes them into the bundle at build time and nothing reads them from the container's runtime environment anymore. The previous single-stage dev-server Dockerfile is preserved unchanged at `frontend/Dockerfile.dev`, restorable via a new `docker-compose.dev.yml` (explicitly not `docker-compose.override.yml`, so a bare `docker compose up` never picks it up by accident) for anyone who wants a containerized Vite dev server instead of the documented host-side `npm run dev` path — that override also carries the dev image's own `512m` `mem_limit` forward, since the base service's limit dropped to `64m` (re-measured against the new nginx-only container, not guessed).

New `scripts/deploy.sh` (bash, not `.mjs` — pure `docker`/`docker compose` orchestration, no Node-side work) runs `docker compose build backend frontend` then `docker compose up -d backend frontend` unconditionally, with `docker exec wireservice-nginx-1 nginx -s reload` gated behind an explicit `--reload-nginx` flag since that's the one step touching shared infrastructure fronting two other domains.

**Verification**: built and ran the new image standalone on a spare port first (before touching the live container) — confirmed static serving, immutable asset caching, and the `/invite/:token` SPA fallback all work, and that the built bundle has the real production API/WS URLs baked in. Only then recreated the live `frontend` container, reloaded `wireservice-nginx-1`, and confirmed both `https://whisper.silentlattice.dev/` and its `/invite/:token` route return `200` against the new bundle. Ran `scripts/deploy.sh` twice (bare, then with `--reload-nginx`) to confirm idempotency, and confirmed it rejects an unrecognized flag rather than silently proceeding. 442 backend tests (441 passing, the one failure the same pre-existing unrelated `aiRoutes.test.js` flake), 65/65 frontend Vitest tests (frontend source itself untouched).

### Security hardening from 2026-07-15 audit: LLM baseUrl allowlist, archived invitation redemption, group-DM member cap

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Security hardening from 2026-07-15 audit: LLM baseUrl allowlist, archived invitation redemption, group-DM member cap" (2026-07-18). Re-verified against the live codebase immediately before implementation — all three were still present, unaffected by the WebSocket-hygiene and admin-boundary fixes that shipped separately.

`backend/src/validation.js` gained `assertAllowedLlmUrl` (layered on top of the existing `assertHttpUrl`), checking the parsed URL's origin against a new `config.llm.allowedLlmOrigins` — sourced from `ALLOWED_LLM_ORIGINS` (comma-separated), defaulting to exactly `LLM_BASE_URL`'s own origin so an out-of-the-box deployment keeps working with nothing else implicitly trusted. `llm/settingsService.js`'s `validateSettingsPatch` now calls it for `baseUrl` instead of the plain syntax check, so `PATCH /api/ai/settings` rejects any origin not on the allowlist (e.g. a loopback or arbitrary internal target) with "baseUrl is not an approved LLM provider origin" — closing the SSRF/global-AI-DoS path a compromised or over-privileged admin session previously had. `backend/src/routes/invitations.js`'s `POST /:token/accept` now re-checks `organizations.archived_at`/`workspaces.archived_at` inside the same row-locked transaction, after the invitation-validity check and before user creation — an invitation created while its target was active can no longer be redeemed once that target is archived, closing a stale-invitation loophole around the existing archive write-freeze. `backend/src/routes/directMessages.js`'s `groupDirectMessagesRouter.post('/')` gained a `MAX_GROUP_DM_MEMBERS` (20) check on `memberIds.length`, before per-element UUID validation or any database lookup.

`RUNBOOK.md`'s env var table and "Switching providers" section updated: `ALLOWED_LLM_ORIGINS` documented, with an explicit note that moving to `vllm` on the target production network requires adding that origin to the allowlist (a restart-time config change) before the `PATCH /api/ai/settings` call that switches providers will succeed. `backend/.env.example` gained the new var.

**Tests**: `backend/tests/llmSettingsService.test.js` — an allowlisted `baseUrl` is accepted and normalized to just its origin (path/query stripped); a well-formed but non-allowlisted origin (a loopback target and an arbitrary internal hostname) is rejected. `backend/tests/invitations.test.js` — a workspace archived after its invitation was created can no longer be redeemed (generic 404, no user row created, invitation stays `PENDING`); same for an organization-scoped invitation. `backend/tests/directMessages.test.js` — a `memberIds` array of 21 is rejected before any `GROUP_DM` channel row is created; exactly 20 succeeds. 442 backend tests (440 passing; two pre-existing failures across two runs, both the same documented `aiRoutes.test.js` "respond first, audit after" race hitting a different one of its own tests depending on timing — reproduced in isolation on an unmodified run, confirming it's unrelated to this change).

### WebSocket connection hygiene: immediate eviction on account disable + payload cap

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "WebSocket connection hygiene: immediate eviction on account disable + payload cap" (2026-07-17).

Both independent architecture reviews' top P0 item. New `disconnectUser(userId, { code, reason })` in `backend/src/ws/connectionRegistry.js` force-closes every live socket for a user (default close code `4004`, reason `"Account disabled"`, an error frame sent first since a close `reason` string isn't reliably surfaced to browser client code); `backend/src/routes/admin.js`'s `POST /users/:userId/disable` calls it synchronously right after `revokeAllRefreshTokensForUser`, in the same request as the `status: 'DISABLED'` update — not queued, since "immediately" was the whole point. That alone only handles sockets already open, so `requireAuth` (`backend/src/auth/requireAuth.js`) now re-checks `users.status === 'ACTIVE'` against the database on every REST call (previously JWT-verification-only, trusting whatever was true at token-issue time), and `ws/server.js`'s `handleAuthenticate` mirrors the identical check for both a first authenticate frame and a re-authenticate frame on an already-open socket — both paths reject with the same generic "Invalid or expired access token" message a truly invalid/expired token gets, so a disabled account can't be distinguished from either case. Separately, `new WebSocketServer(...)` gained `maxPayload: config.ws.maxPayloadBytes` (new `WS_MAX_PAYLOAD_BYTES`, default 131072/128 KiB — sized above the worst-case UTF-8 encoding of a `MAX_MESSAGE_LENGTH` message plus JSON framing overhead, so no legitimate frame is ever at risk), closing an unauthenticated memory/CPU exhaustion vector before a frame is ever buffered or reaches `JSON.parse`.

A real bug found by testing, not by inspection: exceeding `maxPayload` surfaces as an `'error'` event on the per-connection socket (`ws`'s receiver rejects the frame before `'message'` ever fires), and `wss.on('connection', ...)` had no `'error'` listener on individual sockets anywhere — an EventEmitter `'error'` event with no listener is a fatal, process-crashing exception in Node, not just a dropped event. Fixed with a no-op `ws.on('error', () => {})` per connection; `ws` already closes the socket itself (code `1009`) once it emits this, so nothing else was needed. Also updated `RUNBOOK.md`'s WebSocket Protocol close-code table with `4004` and the new payload cap.

**Tests**: `backend/tests/ws.test.js` — disabling a connected user force-closes their socket within the same test (not just on a later reconnect attempt); a disabled user's still-unexpired token is rejected on a fresh authenticate attempt; a disabled user's still-unexpired token is rejected on a re-authenticate frame sent over an already-open socket (status flipped directly via the DB in this one, isolating the reauth branch from the separate eviction path the first test covers); a frame larger than `WS_MAX_PAYLOAD_BYTES` closes the connection with code `1009`. `backend/tests/auth.test.js` gained a test proving a still-unexpired access token is rejected by `GET /api/auth/me` on the very next request after disable (previously only login/refresh were covered). 436 backend tests (435 passing, the one failure the same pre-existing `aiRoutes.test.js` audit-row race documented in prior entries — reproduced identically on a clean `main` via `git stash`, confirming it predates this change).

### Security hardening: global admin boundary and cross-workspace channel-member injection

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Security hardening: global admin boundary and cross-workspace channel-member injection" (2026-07-17).

Fixes the two High-severity findings from `Security.md`'s 2026-07-15 review. `requireSystemPermission`'s "system admin OR OWNER/MANAGER in any workspace" fallback for `GET /api/audit/logs`, `POST /api/audit/verify`, `GET /api/ai/settings`, and `PATCH /api/ai/settings` is replaced by a direct `requireSystemAdmin` (`is_system_admin`-only) gate — self-service workspace creation, which grants OWNER automatically, no longer grants any access to these global, non-workspace-scoped surfaces. `POST /api/workspaces/:workspaceId/channels/:channelId/members` now proves `channel.workspace_id === workspaceId` before any target-membership check, using `channel.workspace_id` (not the path parameter) for the archived-workspace check and the target user's workspace-membership lookup — a mismatched workspace/channel pair 400s without inserting `channel_members`. Frontend `AdminPanel.jsx`'s "AI Settings"/"Audit Log" rows moved from the workspace-admin-gated group to the system-admin-only group (alongside "System Admin"); "Manage Users" stays workspace-scoped, since `UserManagementPanel` enforces its own per-workspace permission server-side regardless.

### Cross-channel "Catch Me Up" workspace digests

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Cross-channel 'Catch Me Up' workspace digest" (2026-07-17).

New `POST /api/ai/workspace-digest` (`requireAuth` + `requireWorkspaceMember`, a new stricter `aiDigestRateLimiter`) sources unread, non-dismissed mentions plus messages from a caller-membership-validated explicit `channelIds` list, both scoped to the requested workspace and a bounded time window (`sinceHours`/`sinceDays`, clamped by a new env-only `AI_DIGEST_MAX_WINDOW_HOURS`), deduplicated and sorted chronologically. Streams back a markdown digest (fixed Urgent Mentions / Action Items / Unresolved Questions / Decisions Made sections) using the same truncate-to-context-window pattern channel-summarize/thread-extract already use, via a new `llm.digest_prompt_version` app_settings key. Audited as `AI_WORKSPACE_DIGEST_REQUESTED` with counts/provider/prompt version/truncated length, never raw content. `runStreamingCompletion` and both real LLM adapters gained an optional cancellation `signal`, wired to the request's `close` event so a client disconnect (including an explicit frontend Cancel) tears down the in-flight upstream request. Frontend: new `WorkspaceDigestPanel.jsx` (window radio, channel checklist, streamed output, Cancel), reachable via a new "Catch Me Up" button on `WorkspaceHome.jsx`.

Two scope reductions from the original design, both flagged in the design text itself as acceptable v1 fallbacks: an explicit per-request `channelIds` list instead of a persisted "starred channels" feature (schema/toggle-endpoints/UI left for a future entry if requested), and single-completion truncation instead of true multi-batch hierarchical summarization (the source set is typically much smaller than a full channel history, so the existing truncation safety valve is a reasonable fit; the audit payload keeps a `chunkCount` field for a future batching pass to extend without a shape change). 13 new backend tests, 2 new frontend Vitest tests.

### Contextual AI action menu and clearer AI output scope

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Contextual AI action menu and clearer AI output scope" (2026-07-17).

`ChannelView.jsx` and `ThreadSidebar.jsx` replaced their standalone `Summarize`/`Extract Tasks` header pills with a shared `Menu.jsx`-based "AI Actions" popover, labeled "Summarize Recent Messages" and "Find Action Items". Generated panels show their scope (`Last 50 messages` / `This thread`) before the streamed output, and the trigger reads "Running AI..." and disables while a request is in flight. New `aiPresentation.js` maps backend `429`/`503` responses to queued/unavailable provider states while leaving other server messages, like validation errors on an empty channel, unchanged. No backend, schema, or audit change — existing AI proxy routes, audit events, per-user rate limiter, and global LLM concurrency gate already covered the required behavior. New `frontend/src/aiPresentation.test.js`; verified with 63/63 frontend unit tests and a clean production build.

### Double-bracket entity registry & autocomplete

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Double-bracket entity registry, autocomplete, and entity detail pages" (2026-07-17).

New workspace-scoped `entities`/`message_entities` tables (migration `0019_entities.js`), unique on `(workspace_id, normalized_name)` so identical entity names coined independently in two different workspaces never collide. `backend/src/services/entityService.js` extracts bounded `[[Entity Name]]` tokens as a best-effort side effect after message send (both REST and WS paths), normalizes whitespace/case, caps processing at 20 entities per message, and find-or-creates entities safely under concurrent first use; DIRECT/GROUP_DM messages are skipped since their channels carry no `workspace_id`. New workspace-member-gated `GET .../entities/search` (existence-hiding 404 for non-members), backed by a `pg_trgm` index and a new `entitySearchLimiter`. `ChannelView.jsx` extends the existing `@mention` autocomplete with a sibling `[[token` detector reusing the same debounce/dropdown/keyboard/caret machinery; `markdown.jsx` renders resolved entities as safe React spans, never `dangerouslySetInnerHTML`, with `mine`-bubble contrast handling, confirmed not to collide with the existing `[text](url)` link syntax. New `backend/tests/entities.test.js` (including the core multi-tenancy regression: two workspaces coining the same entity name never collide) and `markdown.test.jsx` coverage.

### Clickable entity profile/detail pages

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Double-bracket entity registry, autocomplete, and entity detail pages" (2026-07-17).

Built on top of the entity registry above. New `GET .../entities/:entityId` and paginated `GET .../entities/:entityId/references`, both workspace-member-gated with existence-hiding 404s for cross-workspace ids, and references additionally filtered to channels the caller can actually read — a workspace member who isn't in a given private channel never sees that channel's references through an entity profile. `markdown.jsx`'s entity spans became clickable via an optional `onEntityClick` callback; `ChatShell.jsx` resolves the clicked entity text against the current workspace (never trusting message text as an id) before opening the new `EntityDetailsPanel.jsx` (a `Sheet`), which shows canonical name, description/aliases, reference count, and a paginated, newest-first recent-references list. Metadata editing (`PATCH .../entities/:entityId`) and jump-to-message scrolling from a reference were deliberately deferred — v1 is read-only navigation.

### Message presentation improvements for team scanability

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Message presentation improvements for team scanability" (2026-07-17).

Channels now always left-align messages with visible author identity; `DIRECT`/`GROUP_DM` conversations keep the original iMessage-style bubble behavior unchanged — the entry's one open design call, resolved directly with the user before implementation. `ChannelView.jsx`/`ThreadSidebar.jsx` show the author name and a neutral initials-avatar circle only on the first message of a same-sender run in channels; the "Reply in thread" button compacts to a count ("3 replies") once replies exist, backed by a new `replyCount` field on `GET /channels/:channelId/messages` and kept live via the existing WS broadcast even for viewers who never opened the thread sidebar. A real bug found by e2e testing, not by inspection: an initial bare "Reply" label for the zero-replies case collided exactly with `ThreadSidebar.jsx`'s own reply-composer submit button, breaking a pre-existing e2e selector — fixed by keeping the full "Reply in thread" phrase until a real count exists. 3 new backend tests, 13 new frontend Vitest tests, 3 new/rewritten e2e tests.

### Live notification system + in-app invitation notification & acceptance workflow

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Remove email-based invitations, and a live notification system + in-app membership-invitation acceptance workflow" (2026-07-16).

New `user_notifications` (sibling to `mention_notifications`, untouched) and `membership_invitations` (userId-addressed, no token — the recipient's own session is the credential) tables. `POST /api/organizations/:orgId/membership-invitations` / `POST /api/workspaces/:workspaceId/membership-invitations` reuse the existing direct-add routes' exact permission gates; `POST/GET /api/membership-invitations/*` handle listing/accept/decline, existence-hiding 404 for anyone but the invited user. `GET /api/notifications/summary` now returns a combined mentions+invitations `unreadCount`. Frontend: `NotificationPanel.jsx` (renamed to "Notifications") gained an Invitations section with Accept/Decline; `WorkspaceSettingsSheet.jsx`/`OrgManagementPanel.jsx` gained a second "Invite (needs acceptance)" action alongside instant-add; `ChatShell.jsx` shows a live toast on arrival that opens the panel directly. 9 new backend tests, 3 new e2e tests.

### Remove email-based invitations

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Remove email-based invitations, and a live notification system + in-app membership-invitation acceptance workflow" (2026-07-16).

`invitations.email` dropped outright (migration `0017`). Creation (`POST .../invitations`) no longer collects or echoes email; redemption (`POST /invitations/:token/accept`) now requires the invitee's own email in the request body, validated the same way `POST /api/admin/users` validates a caller-supplied email. Frontend invite forms lost their email inputs; `InviteRedemptionPage.jsx` gained one. Pending-invitation tables show "Invited by" in place of the now-gone Email column. Rewrote `invitations.test.js` throughout; new tests cover a self-supplied email colliding with an existing account, and two distinct invitations each redeemable with a distinct self-chosen email.

### Display names settable in the admin account-creation worksheet

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Display name self-service editing, admin-worksheet field, and organization creation from System Admin" (2026-07-16).

`POST /api/admin/users` now accepts an optional `displayName`, validated with a new `assertDisplayName` in `validation.js`; falls back to `username` when omitted. New `PATCH /api/auth/me/display-name` (`requireAuth`, no `:userId` — always acts on the caller alone) closes the deferred self-edit gap. Frontend: `SystemAdminPanel.jsx`'s create-user form gained an optional "Display name" field; new `DisplayNamePanel.jsx` (`Sheet`-based, modeled directly on `ChangePasswordPanel.jsx`) reachable from a "Display Name" entry next to "Change Password" in the user menu, wired through a new `AuthContext.setDisplayName`. 8 new backend tests, 2 new e2e tests.

### Manage organizations (create, modify, delete) in the frontend

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Display name self-service editing, admin-worksheet field, and organization creation from System Admin" (2026-07-16).

`SystemAdminPanel.jsx`'s "Organizations" section gained a "Create organization…" button opening the existing `CreateOrganizationModal.jsx` unchanged, refreshing the same `organizations` list state the table already reloads after rename/archive/unarchive. The workspace switcher's own "+ Create organization…" item was left in place as a second entry point, per the design's own "two doors, not a conflict" call. Frontend-only, no backend change. 1 new e2e test.

### Direct Messages as a first-class navigation section

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Direct Messages navigation and navigation-first sidebar redesign" (2026-07-16).

New `GET /api/direct-messages` (member/last-message summaries for every DIRECT/GROUP_DM channel the caller belongs to) and `GET /api/organizations/:orgId/members-search` (plain-member-gated roster search backing the picker). New `NewMessageSheet.jsx` (a multi-select `PeoplePicker`; one person starts/reopens a 1:1 DM, more than one starts a group DM), an always-visible "Direct Messages" section in `WorkspaceSidebar.jsx` (not gated on a workspace being selected), and `ChannelView.jsx` header copy that reflects people ("Direct message" / "N people", a person/people icon, no `#`) instead of a channel. Selecting a DM resolves through `ChatShell.jsx`'s existing channel-selection path with no workspace highlight required. 10 new backend tests, 3 new e2e tests.

### Navigation-first sidebar redesign

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Direct Messages navigation and navigation-first sidebar redesign" (2026-07-16).

Removed `WorkspaceSidebar.jsx`'s inline `InviteToChannelForm` and its channel-row "•••" > "Invite to channel…" overflow item — `ChannelDetailsPanel`'s "Add people" section (already shipped as a second entry point) is now the sole one. Moved the "Admin" hub trigger out of its own always-visible top-of-sidebar row into the user menu, opened on demand rather than sitting in the same permanent vertical rhythm as search/workspaces/channels. Two existing e2e tests rewritten off the removed sidebar flow onto the channel details panel; every e2e call site opening the Admin hub updated to go through the user menu first.

### Workspace home and actionable empty states

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Workspace home and actionable empty states" (2026-07-16).

New `WorkspaceHome.jsx`, rendered by `ChatShell.jsx` whenever a workspace is selected with no channel open — workspace name, archived/read-only note, channel list (`Open`/`Join` per row, reusing already-loaded data), and permission-aware "Create Channel"/"Invite People" actions (the latter opening the same `WorkspaceSettingsSheet` its overflow-trigger counterpart does), with first-run copy for a brand-new channel-less workspace. Two real bugs found by e2e testing: virtually every existing `text=`-based workspace/channel-name locator in the e2e suite became ambiguous, since the main pane now shows the same name the sidebar already does the instant a workspace auto-selects on load — fixed with `aside`-scoped `selectWorkspaceRow`/`selectChannelRow` helpers across ~35 call sites; and a genuine, previously-invisible product bug where switching organizations filtered the sidebar's workspace list but never cleared the *selected* workspace, so the main pane kept showing an orphaned workspace's full home after its org fell out of view — fixed with a new effect in `ChatShell.jsx`.

### Dedicated admin/settings area

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Dedicated admin/settings area" (2026-07-16).

New `WorkspaceSettingsSheet.jsx` (workspace-scoped: invite an existing member, create an invite link, visibility, managers-can-archive, transfer ownership, archive — each section gated on the same permission its old overflow-menu item used) and `AdminPanel.jsx` (a single "Admin" hub sheet listing Manage Users/AI Settings/Audit Log/Manage Organization/System Admin, each still opening its existing, unchanged panel). Replaces `WorkspaceSidebar.jsx`'s per-workspace overflow menu (previously up to five separate items: Invite member…, Create invite link…, Archive workspace, Transfer ownership…, the visibility-toggle label, and the managers-can-archive checkbox) and the old "Admin Tools" dropdown plus the org switcher's separate "Manage organization members…" item. Confirmed with the user before implementation: workspace member roster/role/removal/password-reset (`UserManagementPanel.jsx`) stays a separate cross-workspace panel reachable from the Admin hub, not merged into Workspace Settings, to keep this round's scope bounded. A real bug found by e2e testing, not by inspection: a successful ownership transfer demotes the caller to Manager, which flips `WORKSPACE_TRANSFER_OWNERSHIP` false on the very next workspace-list refetch — unmounting the transfer section (and its "Ownership transferred" success message) before it could ever be seen. Fixed by having a successful transfer close the whole settings sheet, the same "closes on success" pattern the Archive section already used, rather than trying to keep a doomed component's local state alive.

### Confirmation and recovery for destructive or high-impact actions

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Confirmation and recovery for destructive or high-impact actions" (2026-07-16).

New `ConfirmDialog.jsx` (a `Sheet` naming the object and consequence, danger-styled confirm, error shown inline on failure rather than closing) wired into all six named actions: Archive Workspace and Transfer Ownership (`WorkspaceSidebar.jsx`), Remove Member and Revoke Invitation (`UserManagementPanel.jsx`, `OrgManagementPanel.jsx`, and — for the same underlying org-membership removal reachable a second way — `SystemAdminPanel.jsx`'s per-account "Manage" row), and Reset Password and Disable Account (`UserManagementPanel.jsx`, `SystemAdminPanel.jsx`). Two real bugs found and fixed by e2e testing: `Sheet.jsx`'s document-level Escape/Tab handling didn't account for `ConfirmDialog` opening non-portaled *inside* an already-open `Sheet` (e.g. Reset Password launched from Manage Users) — pressing Escape closed both panels at once, fixed by scoping each `Sheet`'s keydown handling to only fire when it currently contains focus; and the running `frontend` container had no source volume mount and needed an explicit rebuild (plus a confirmed `wireservice-nginx-1` reload) to pick up the change at all, the same class of gap previously found for `backend`.

### Focused creation sheets for workspaces and channels

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Focused creation sheets for workspaces and channels" (2026-07-16).

New `CreateWorkspaceSheet.jsx` (name, org selector when the caller has >1 org, Invite-only/Listed radio choice with inline consequence explanation) and `CreateChannelSheet.jsx` (name, Open/Private radio choice, optional initial invitees via `PeoplePicker` for private channels) replace `WorkspaceSidebar.jsx`'s old inline sidebar-row forms. Both block submit inline for empty/over-length names. Two real bugs found and fixed by e2e testing: an HTML `maxLength` attribute silently truncated input, making the "too long" validation message unreachable; and `PeoplePicker`'s multi-select mode reopened its dropdown over the submit button after every pick, via a programmatic refocus triggering the same handler a real click would.

### Channel details panel with private-channel member management

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Channel details panel with private-channel member management" (2026-07-16).

New `ChannelDetailsPanel.jsx` (a `Sheet`) reachable from a new info-icon button in `ChannelView.jsx`'s header, alongside an inline "Private · N members" / "Open · N members" meta line. Shows privacy, member count, workspace context, the full roster (display name + presence), and an "Add people" section (`PeoplePicker`) for eligible callers; archived workspaces render read-only. Backend gained `memberCount` on the channel list and a new uncapped `GET /:workspaceId/channels/:channelId/members` roster endpoint, distinct from the existing capped mention-autocomplete search. `WorkspaceSidebar.jsx`'s existing "Invite to channel…" overflow item was deliberately left in place as a second entry point — removing it is the later, separate sidebar-redesign entry's job.

### Unified people picker for member, invite, ownership, DM, and mention flows

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Unified people picker for member, invite, ownership, DM, and mention flows" (2026-07-16).

New `PeoplePicker.jsx` (search-and-select, single/multi-select, ineligible rows shown disabled with a reason) backed by three scoped endpoints matching each call site's real candidate pool: `GET /workspaces/:workspaceId/people-search` (any account, for workspace/org add), `GET /workspaces/:workspaceId/members-search` (current roster only, optional `?channelId=`, for private-channel invite and ownership transfer), `GET /organizations/:orgId/people-search`. Replaced the exact-username inputs in `WorkspaceSidebar.jsx` (invite member, invite to channel, transfer ownership) and `OrgManagementPanel.jsx` (add org member); mention autocomplete already had its own equivalent and was left alone. A real request-ordering race (an on-focus empty-query search resolving after a typed one, clobbering the correct filtered results) found and fixed with a request-sequence guard, locked in with a permanent e2e regression test. Last of the five dependency-ordered foundational UI/UX entries in this batch.

### Standard modal/sheet component and interaction pattern

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Standard modal/sheet component and interaction pattern" (2026-07-16).

New `Sheet.jsx` extracts the backdrop/panel/header/title/subtitle/close-button shell every modal panel had independently hand-copied, adding real dialog semantics none of them had: focus trap, Escape-to-close, return-focus-on-close, and optional dirty-form confirmation on backdrop click/Escape. All eight target panels (AiSettingsPanel, AuditDashboard, ChangePasswordPanel, UserManagementPanel, BrowseWorkspacesPanel, CreateOrganizationModal, OrgManagementPanel, SystemAdminPanel) migrated onto it, preserving each panel's existing `aria-label` strings and per-panel width/height. Dirty-form protection wired for the three panels with an actual top-level form (password change, AI settings, create-organization); the five list/table-driven panels keep their existing (already fine) backdrop-click-closes-immediately behavior. Four new e2e tests cover Escape, clean-vs-dirty backdrop-click behavior, and the focus trap.

### Consistent local icon system for controls

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Consistent local icon system for controls" (2026-07-16).

`lucide-react` (0 vulnerabilities) replaces every emoji/text glyph in scope — menu chevrons, close buttons, channel privacy, notification state, appearance, admin/search/plus affordances, the menu checkmark, and AI action sparkles — with `aria-hidden` icons paired with visible text or an existing `aria-label`. Two real, verified bugs found and fixed while visually confirming the change: a flexbox `min-width` shrink bug that clipped the new-channel form's "Private" label, and `Menu.jsx`'s popover having no `maxHeight`/scroll container at all, letting a long item list (e.g. the organization switcher after many accumulated test orgs) render past the bottom of the viewport with no way to reach it. `frontend`'s Docker Compose `mem_limit` bumped 128MB → 512MB after the container was confirmed `OOMKilled` on cold start — `lucide-react` pushed Vite's dev-server dependency pre-bundling over the old limit.

### Display names as the primary identity

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Display names as the primary identity" (2026-07-16).

`displayName` returned additively (alongside unchanged `username`) from every user-facing payload: auth, message authors and thread replies, mention notifications, channel member search, workspace/org rosters, admin user/workspace lists, invitation metadata, and semantic search. Carried through JWT claims by exact analogy to how `username` already worked, avoiding a per-message DB lookup. Frontend renders display name first everywhere a person is shown to another human, with `@username` as a secondary disambiguator only when it differs. AI prompt content and the username-input membership/ownership-transfer forms were deliberately left untouched — the former is prompt-template content, the latter is superseded by the people-picker entry below.

### Clear information architecture and terminology for organizations, workspaces, channels, and DMs

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Clear information architecture and terminology" (2026-07-16).

"Subscribe" → "Join" and "Browse workspaces" → "Join a workspace" throughout; workspace visibility surfaced as "Listed"/"Invite-only" instead of "Discoverable"/"Private" (enum values on the wire unchanged); one-sentence tooltip helper copy on both visibility toggles; the organization switcher now only renders when there's an actual decision or admin action available, hiding it entirely for the common case of a plain member in exactly one organization. Frontend-only. One real bug found and fixed by the e2e regression pass (not by inspection): the "Join a workspace" rename collided with an existing unscoped `button:has-text("Join")` locator in the mentions test, intermittently clicking the wrong button — fixed by scoping the locator to its channel row.

### Persistent mention notifications display

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Persistent mention notifications display" (2026-07-15).

Adds durable `mention_notifications` rows, membership-filtered mention listing and unread summaries, mark-read/read-all endpoints, notification ids on live mention frames, a sidebar unread badge, and a Mentions panel in the user menu. The existing in-app toast and browser notification behavior now share the same navigation/read-state path where a persisted notification id is available. Backend coverage added for REST/WS persistence, dedupe, scoped read state, and stale private-channel access filtering.

### Enterprise authorization model: organizations, permission-based roles, invitations, no hard deletes

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Enterprise authorization model, slice 4: account lifecycle, ownership transfer, and the full test-suite migration" (2026-07-15), for the full writeup, and the slice 1-3 entries immediately before it for the rest of the history.

Shipped across four slices (2026-07-14 through 2026-07-15), per the sequencing this entry's own original design called for: schema/permission model/authz cutover (slice 1) → invitations + organization routes (slice 2) → frontend (slice 3) → closing self-service signup, account lifecycle, ownership transfer, and the full test-suite migration (slice 4). The end state matches the original design closely: organizations as first-class objects with explicit membership separate from workspace membership; `OWNER`/`MANAGER`/`MEMBER` workspace roles and `ORG_ADMIN`/`ORG_MEMBER` org roles resolved through a permission catalog (`backend/src/authz/permissions.js`) rather than raw string comparisons; a decoupled, token-based invitation object; `users.status`/workspace `archived_at`/`visibility` as first-class fields; a guaranteed at-least-one-owner-per-workspace invariant; `REVOKE DELETE` on every audit-referenced table; and every account now originating from a system admin (`scripts/create-first-admin.mjs`, `POST /api/admin/users`) or invitation redemption, never self-service signup.

A handful of scoping decisions shifted the delivered shape from the original design text, each confirmed directly with the user or found necessary during implementation rather than guessed: `managers_can_archive` is an owner-delegated per-workspace toggle rather than a blanket grant; `WORKSPACE_MANAGE_MEMBERS`/`WORKSPACE_MANAGE_MANAGERS` is a real, intentional tightening of what a `MANAGER` could do versus the original flat design; ordinary workspace admins lost direct account-provisioning entirely (no workspace-scoped replacement — they fall back to invitations); `USERS_*`/`ORGS_VIEW_ALL`/`WORKSPACES_VIEW_ALL`/`SYSTEM_ADMIN_STATUS_CHANGE` were never added to the permission catalog, since every route they'd back is gated by a direct `is_system_admin` check instead, and unused constants would violate this codebase's own no-dead-abstraction convention; and `GET /workspaces/admin/all`/every `/api/admin` route deliberately bypass `requireSystemPermission`'s OWNER/MANAGER-of-any-workspace fallback (kept narrowly for AI-settings/audit continuity) in favor of a direct system-admin-only gate, to avoid an unintended cross-tenant information-disclosure widening.

### Light/Dark appearance toggle (System / Light / Dark)

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Light/Dark appearance toggle (System / Light / Dark)" (2026-07-13).

New `frontend/src/context/ThemeContext.jsx` (`AuthContext.jsx`'s exact pattern), holding `theme: 'system' | 'light' | 'dark'` persisted to `localStorage['sw-theme']` and applied via `data-theme` on `document.documentElement` — `global.css`'s token set and `prefers-color-scheme` layer needed zero changes, they were already there. One correction made during implementation: the design's suggested inline `<script>` in `index.html` for the before-first-paint flash fix would violate the CSP's `scriptSrc: ["'self'"]` (no `unsafe-inline`, `PROJECT_PLAN.md` Section 3) — applied instead as the first statement in `main.jsx` (an external, CSP-compliant module), the design's own flagged fallback. `Menu.jsx` turned out to already support a `checked` item state (`role="menuitemcheckbox"`), so no menu-component changes were needed either — just three new entries in `WorkspaceSidebar.jsx`'s existing user menu. `resolveTheme()` kept pure and DOM-free specifically so it stays unit-testable without adding a jsdom-style test environment (this frontend's Vitest setup has none, by established precedent — see `markdown.test.jsx`); the DOM/`localStorage` side is covered by a new e2e test instead. 23/23 frontend Vitest tests (6 new), 1 new e2e test, `npx vite build` clean, visually verified in both themes via screenshot.

### Self-service workspace subscription (discover + join)

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Self-service workspace subscription (discover + join)" (2026-07-13).

`workspaces.visibility` (migration `0010_workspace_visibility.js` — `0008`/`0009` were already taken by archiving/pgvector by the time this shipped), defaulting every workspace to `PRIVATE`. `POST /workspaces` gained an optional `visibility` field; new `GET /workspaces/discoverable` and `POST /:workspaceId/subscribe` (existence-hiding 404 for non-`PUBLIC`/nonexistent, 409 for archived, idempotent-safe, audited as `WORKSPACE_MEMBERSHIP_CHANGE`/`action: 'subscribe'`) — resolving an internal contradiction in this entry's original Design text in favor of its own Tests section (404, not 400). Frontend: a visibility checkbox on the existing "+ New workspace" form and a new "Browse workspaces" button placed inline next to it (a placement chosen over the user account menu, since this is a workspace-list action), opening a new `BrowseWorkspacesPanel.jsx` modeled on `AuditDashboard.jsx`. Two pre-existing deployment-step gaps caught during verification (both `backend` and `frontend` Docker images needed rebuilding to pick up the change, the same class of issue the `@mention autocomplete` entry below already found for `backend` alone) and one e2e test bug (asserted global text-invisibility instead of scoping to the specific row via a new per-row `aria-label`, since this stack has no per-e2e-test data reset). 213/214 backend tests (11 new, 1 pre-existing unrelated flake), 17/17 frontend Vitest tests, 1 new e2e test.

### iMessage-style message bubble layout

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "iMessage-style message bubble layout" (2026-07-13).

`ChannelView.jsx`'s message rows split into an outer alignment container (`justifyContent` per `isMine`) wrapping an inner bubble carrying the fill/`maxWidth`/`sl-row` hover class. "Mine" reuses `--brg`/`--item-active-fg` (the sidebar's existing filled-active-row precedent); "theirs" reuses `--surface-alt`/`--text-1`. Author name shown only on others' bubbles; timestamp always visible, no hover-reveal. Consecutive same-sender messages get tighter `paddingBottom`. The design's green-on-green mention-contrast concern turned out to have two more instances beyond what was flagged — `markdown.jsx` gained a `variant: 'mine'` option covering both mentions and links (same `--brg`-on-`--brg` collision, fixed by direct analogy), and `PresenceBadge.jsx` gained a contrasting ring rather than a color swap since its dot color is itself meaningful status data. `ThreadSidebar.jsx` got the identical treatment. One comprehensive e2e test. No backend changes.

### @mention autocomplete in the message composer

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "@mention autocomplete in the message composer" (2026-07-13).

New `GET /channels/:channelId/members?q=&limit=` (`backend/src/routes/messages.js`) — the first "who is in this channel" read endpoint anywhere in the app — same existence-hiding gate as message history, self-exclusion, capped results, a new per-user `memberSearchLimiter`. `ChannelView.jsx`'s composer gained caret-anchored `@token` trigger detection, a 200ms-debounced lookup, a `role="listbox"`/`option` dropdown dismissed via the same outside-mousedown-listener pattern the Apple HIG entry established for `Menu.jsx`/`SearchBar.jsx` (a deliberate deviation from the design's suggested blur-plus-delay), keyboard (Arrow/Enter/Tab/Escape, with Enter's default prevented so it doesn't also submit the message) and mouse selection, and caret repositioning via `useLayoutEffect`. Two real, non-app bugs found during verification: the running `backend` Docker container had no source volume mount and was still serving the pre-endpoint image (`npm test` runs against source directly and had already passed, masking it) until rebuilt; and the new e2e test's own `Locator.fill()` calls silently no-op'd when re-filling an input to its already-current value (a React value-tracker quirk, fixed in the test, not the app). 6 new backend tests, one comprehensive e2e test. Combined with the bubble-layout entry above: 203 backend tests (202 passing, pre-existing unrelated flake), 17/17 frontend unit tests, 23/23 e2e tests across three signup-budget-safe batches.

### Basic Markdown formatting in messages

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Basic Markdown formatting in messages" (2026-07-13).

New hand-rolled tokenizer (`frontend/src/markdown.jsx` — `.jsx`, not `.js`, since Vite rejects JSX syntax in a plain `.js` file), zero new runtime dependencies. `renderMessageContent()` replaces `ChannelView.jsx`'s old `renderContentWithMentions` as the single content-rendering entry point, now also used by `ThreadSidebar.jsx` — closing a real pre-existing gap where thread replies never highlighted `@mentions` at all. Ordered passes (links, then bold, then italic, then mentions) share one `applyPass` primitive that only re-scans plain-text segments left over from the previous pass. Link scheme validated client-side (mirrors `validation.js`'s `assertHttpUrl`) — an unsafe scheme like `javascript:` renders as plain label text, never a clickable anchor; every real link gets `target="_blank" rel="noopener noreferrer"`. Four real bugs found by testing before this reached a browser: mentions weren't actually reachable inside bold/italic text (fixed by re-running the mention pass on bold/italic's own captured content); `__init__`-style Python dunders were read as bold (fixed by rejecting a single-bare-identifier underscore match, trading away single-word `__x__`/`_x_` in favor of asterisks, which don't share the ambiguity); a URL containing its own parens got truncated at the first `)`, leaving a stray character behind; and no frontend unit-test runner existed at all, so Vitest was added (`frontend/vitest.config.js`, scoped to `src/`, now also available for `Menu.jsx`'s coverage flagged as a gap in the entry below). 15 new Vitest unit tests, 2 new e2e tests, 24 e2e tests passing total. No backend changes — `messages.content` and the wire format are untouched.

### Apple HIG UI/UX overhaul: progressive-disclosure menus + a dedicated search bar

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Apple HIG UI/UX overhaul: progressive-disclosure menus + a dedicated search bar" (2026-07-13).

New reusable `Menu.jsx` (portal-rendered, `role="menu"`, keyboard-navigable, HIG grouping/ordering rules) collapsed `WorkspaceSidebar`'s flat button clutter into three pull-down-button-style menus: a user menu (notifications/Change Password/Sign out, replacing six always-visible `userRow` controls with one trigger), an "Admin Tools" menu (AI Settings/Audit Log/Manage Users), and a per-workspace "•••" overflow menu consolidating Invite and Archive — previously scattered in two unrelated parts of the sidebar for the same object, now both gated per-row on that workspace's own role/ownership. New `SearchBar.jsx` replaces the "Search" button + full-modal `SemanticSearchPanel.jsx` (deleted) from the entry below with a persistent field docked at the top of the sidebar and an anchored results popover — same backend, debounced (450ms/2-char minimum) with Enter forcing an immediate search, scope narrowing de-emphasized to match Apple's actual documented preference ("favor improving search results over including a scope bar") rather than a permanent segmented control. Two real bugs found by testing: `Menu.jsx` was closing itself on any window scroll (including one an interaction could trigger incidentally), detaching the very item being clicked mid-selection; `SearchBar.jsx`'s Escape handling checked a proxy condition that was false during the debounce-pending window, clearing the query on the first Escape instead of just dismissing the popover. All existing e2e tests whose target UI moved were updated in place (workspace invite, archive/unarchive, change password, admin surfaces, admin user management), plus three new tests for the menus themselves. No backend/authorization/audit changes anywhere. 22 e2e tests passing, backend suite unaffected (196/197, pre-existing unrelated flake).

### Semantic message & channel search via pgvector

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Semantic message & channel search via pgvector" (2026-07-12).

`pgvector/pgvector:pg16` replaces `postgres:16-alpine` (migration `0009_pgvector_and_embeddings.js`: `vector` extension, `message_embeddings` + HNSW cosine index, `embedding_jobs` work-queue table). `llm/adapters/*.js` gained `embed()` alongside `generate()`/`checkHealth()` for all three providers, reusing the live `app_settings`-overridable provider rather than a separate config surface. New `backend/src/search/` (`embeddingConcurrencyGate.js`, `embeddingService.js`, `embeddingQueue.js`, `embeddingWorker.js`) handles async, failure-tolerant ingestion — enqueued as a sibling step at both the REST and WS message-send call sites, processed by a polling worker with retry/dead-letter. `POST /api/search/semantic` (`routes/search.js`) embeds the query, ranks by cosine similarity, and authorizes via the existing membership helpers plus a `channel_members`-filtered join for the cross-channel case; audited as `AI_SEMANTIC_SEARCH_REQUESTED` with query length/model/result count, never raw query text. Frontend: `SemanticSearchPanel.jsx`, reachable via a "Search" button available to every user. 196/197 backend tests (one pre-existing, unrelated flake), 1 new e2e test passing in isolation.

### Workspace archive / unarchive

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Workspace archive / unarchive" (2026-07-12).

`archived_at`/`archived_by` on `workspaces` (migration `0008_workspace_archiving.js`). `POST /workspaces/:workspaceId/archive` (owner-or-admin, idempotent), `POST /workspaces/:workspaceId/unarchive` (admin only, deliberately narrower). New `requireWorkspaceOwnerOrAdmin`/`requireWorkspaceNotArchived` helpers in `authz/membershipService.js`, the latter wired into every write path that touches a workspace or its channels — including the admin dashboard's role-change/user-creation endpoints, which postdate this design's original write and needed the same gate extended to them. `GET /workspaces` now returns `archivedAt`; `WorkspaceSidebar` splits into "Workspaces"/"Archived" sections and renders an archived workspace's composer as read-only. Audited as `WORKSPACE_ARCHIVE_STATUS_CHANGE`. 171/171 backend tests, 14/14 e2e tests passing.

### Admin dashboard: user provisioning, role assignment & password reset

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Admin dashboard: user provisioning, role assignment & password reset" (2026-07-12).

Four new workspace-scoped endpoints in `backend/src/routes/workspaces.js`, all gated on `requireWorkspaceAdmin`: `GET /:workspaceId/members` (roster — a gap the original design didn't spell out, found during implementation), `PATCH /:workspaceId/members/:userId` (role change with a last-admin guard), `POST /:workspaceId/users` (admin-provisioned account creation, transactional with the workspace-membership insert), `POST /:workspaceId/members/:userId/reset-password` (revokes the target's sessions, rejects targeting the caller's own id in favor of the self-service flow). New `USER_ACCOUNT_CREATED`/`ADMIN_PASSWORD_RESET` audit types, new per-admin rate limiters. Frontend: `UserManagementPanel.jsx`, reachable via a third "Manage Users" button in `WorkspaceSidebar`'s `adminToolsRow`. 155/155 backend tests, 13/13 e2e tests passing.

### Self-service password change

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Self-service password change" (2026-07-12).

`POST /api/auth/change-password` (`backend/src/routes/auth.js`), behind `requireAuth` and a new per-user `changePasswordLimiter`. `currentPassword` verified via `bcrypt.compare` (401 on mismatch), `newPassword` validated via the existing `assertValidPassword`, every outstanding refresh token revoked and a fresh access+refresh pair issued in the same response (current session keeps working, every other session is forced to re-authenticate), audited as `AUTH_PASSWORD_CHANGE`. Frontend: `ChangePasswordPanel.jsx` (same modal pattern as `AiSettingsPanel`/`AuditDashboard`), reachable from a "Change Password" control next to "Sign out" in `WorkspaceSidebar` for every user. 136/136 backend tests, 12/12 e2e tests passing.

### Contextual user mentions (@username) & browser notifications

**Status**: Done — see `PROJECT_PLAN.md` Section 11, "Contextual user mentions (@username) & browser notifications" (2026-07-12).

Regex-based `@username` extraction (`backend/src/services/mentionService.js`), targeted per-recipient WebSocket delivery (`connectionRegistry.js`'s `sendToUser`) wired into both the REST and WS send paths, a click-to-opt-in browser Notification permission control, an always-on in-app toast fallback, and an `@username` highlight in the message feed. 131/131 backend tests, 11/11 e2e tests passing.
