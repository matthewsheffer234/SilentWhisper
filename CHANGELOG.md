# Changelog

Tracks every version actually cut for shipment into an air-gapped enclave — one entry per **release**, not per dev session. For that finer-grained history (every change, every deviation from a design, every test run) see `PROJECT_PLAN.md` Section 11's implementation log; for the backlog those changes came from, see `FEATURE_REQUEST.md`. This file exists for one purpose: given a version currently installed in an enclave, know what's different in the next one, and what an upgrade will actually touch, without reading either of those in full.

See `RUNBOOK.md`'s "Enclave Upgrade" section for the upgrade procedure itself (`scripts/airgap-upgrade.sh`).

## Versioning

`SILENTWHISPER_VERSION` (the tag on the images `scripts/build-release-images.sh` produces, and the version this file's headings track) follows semver-ish rules, read from the enclave operator's perspective:

- **PATCH** (`1.0.x`) — bug fixes only. No new migration, no new required env var, no behavior change beyond "the bug is gone."
- **MINOR** (`1.x.0`) — new features and/or new migrations, always additive/non-destructive (new tables/columns, never a dropped or renamed one; new env vars always have a working default). `scripts/airgap-upgrade.sh` handles these unattended.
- **MAJOR** (`x.0.0`) — anything an operator must act on beyond running the upgrade script: a destructive or manually-reviewed migration, a required env var with no safe default, a breaking API/config change. Called out explicitly in that version's entry, with the manual step spelled out — never silently bundled into a routine upgrade.

Each entry lists the migrations and new env vars it introduces, so an operator can tell what an upgrade will change before running it.

**Cadence, stated explicitly rather than left to guesswork**: in practice this means roughly one release per shipped commit that touches `backend/`, `frontend/`, `scripts/`, or `database/migrations/` — see `v1.1.0` and `v1.1.1` as the pattern, two releases the same day for two separate commits, not batched into a periodic drop. Small, tightly-scoped releases keep each individual upgrade's blast radius easy to reason about and roll back; batching several unrelated changes into one version number just makes `scripts/airgap-upgrade.sh`'s all-or-nothing bring-up riskier for no real benefit. `CLAUDE.md`'s Rules of Engagement (`PROJECT_PLAN.md` Section 9) makes this a standing requirement, not a one-off — every such commit gets its `CHANGELOG.md` entry and version bump in the same commit, not a follow-up step.

## [1.12.0] — 2026-07-27

**Migrations**: none. **New env vars**: none.

Implemented `FEATURE_REQUEST.md` backlog entry 2, "Consolidate the admin surface: tabbed panels instead of stacked modals, and a persistent entry point" — the fix that followed directly from a code-grounded review of System Administration UX against Apple's HIG the user asked for.

- `SystemAdminPanel.jsx`'s three previously un-tabbed, continuously-scrolling domains (account creation/roster, organizations, all workspaces) are now Accounts/Organizations/Workspaces tabs, reusing `AdminAnalyticsPanel.jsx`'s existing tab bar (`TABS` array, `styles.tab(active)`/`styles.tabBar`) rather than a second, competing pattern.
- `WorkspaceSettingsSheet.jsx` split into an exported, unwrapped `WorkspaceSettingsContent` and a thin `Sheet`-wrapped default export (unchanged for its ordinary `WorkspaceSidebar.jsx`/`ChatShell.jsx` caller). `SystemAdminPanel`'s Workspaces tab now swaps to `WorkspaceSettingsContent` in place — with a "← Back to All Workspaces" control — instead of stacking a second full `Sheet`/backdrop on top of an already-open one, closing the exact "don't present a sheet from within another sheet" gap the review found. `ConfirmDialog` opening on top of one `Sheet` (Disable Account, Archive Workspace, etc.) is unchanged — that single-level alert stacking was never the problem.
- `WorkspaceSidebar.jsx` gains a persistent, icon-only Admin trigger next to the username, gated on the same `showAdminButton` boolean the existing user-menu "Admin" row already computes — costs a plain member nothing. The user-menu item is kept, not replaced, per the entry's own explicit transition-period recommendation.

Four new e2e tests (workspace master-detail swap producing exactly one dialog, the persistent icon visible for a system admin, hidden for a capability-free member) plus two existing tests updated for the new tab clicks. Full 147-test frontend unit suite and production build pass. E2e verified against a locally-rebuilt build: 9/11 in the affected suite passed clean (the 2 failures are pre-existing and unrelated — one reproduces identically on unmodified `main` via `git stash`, the other traces to a hardcoded `"Default Organization"` test assumption that doesn't match this database's actual earliest org); a later, larger batch hit the login rate limiter (`loginIpLimiter`, 20/15min per IP) from cumulative session test volume, not a regression.

Full diff: `git diff v1.11.1..v1.12.0`.

## [1.11.1] — 2026-07-27

**Migrations**: none. **New env vars**: none.

Fixed a real bug in `v1.11.0`'s highlight formatting, reported directly by the user testing it live: a `==highlighted==` span that also contained `**bold**`, `*italic*`, or `***bold-italic***` rendered as stray literal `==`/`**` characters instead of a highlight — the highlight didn't render at all, not just the nested emphasis. Root cause: `frontend/src/markdown.jsx`'s tokenizer pass order ran bold/italic/bold-italic *before* highlight; those passes fragment a message into an array of (string | already-tokenized element) pieces around whatever they match, and the highlight pass only ever scans one contiguous string fragment at a time (by design — see `applyPass`'s own comment). A `**bold**` run in the middle of a `==...==` span split its opening and closing `==` into two separate fragments before the highlight pass ever ran, so neither delimiter pair was recognized as anything.

Fixed by moving the highlight pass ahead of bold/italic/bold-italic in `applyInlinePasses`, so a `==...==` span is recognized whole before anything inside it gets a chance to fragment it. Content inside a mark still only gets the existing entity/mention nested pass — bold/italic syntax inside a highlighted span renders as literal characters rather than nesting, the same one-level-of-nesting limit bold/italic content already has (documented via a new test rather than left implicit). Four new regression tests in `markdown.test.jsx` cover the exact failure (highlight containing each of the three emphasis forms) plus the documented nesting boundary.

Full diff: `git diff v1.11.0..v1.11.1`.

## [1.11.0] — 2026-07-26

**Migrations**: none. **New env vars**: none.

Messages now support Obsidian-style bold-italic (`***text***`/`___text___`, rendering `<strong><em>`) and highlight (`==text==`, rendering `<mark>`) markdown, closing the last gap between this app's formatting and Obsidian's own inline-emphasis notation (bold and italic on their own already matched exactly). Fixes `FEATURE_REQUEST.md` entry 1 — `***text***` previously rendered visibly broken (a stray leading `*` inside the bold, two stray trailing `*` after it), since the existing bold pass matched one character short of a real triple-star close; `==text==` previously did nothing at all. Both new tokens compose with `@mention`/`[[Entity]]` highlighting one level deep, matching how bold/italic already do. Also fixed, found while implementing the above: two now-malformed variants (`***text**`, `***text*`) previously fell through to the plain bold/italic passes and produced the same class of broken partial render — both now correctly fall back to fully literal text.

No backend change: `assertMessageContent` already permitted `*`/`_`/`=` with no character-class restriction, and embedding already worked on raw content.

Full diff: `git diff v1.10.0..v1.11.0`.

## [1.10.0] — 2026-07-26

**Migrations**: none. **New env vars**: none.

The message composer (both the main channel view and the thread reply sidebar) is now a `<textarea>` instead of a plain single-line `<input>`, so a message can hold a real newline. Fixes `FEATURE_REQUEST.md` entry 2 — previously there was no way to compose a multi-line message at all; `<input>` rejects newline characters outright, so this needed an element change, not just a keybinding. Shift+Enter inserts a line break; bare Enter still sends, matching the old implicit-submit behavior. The composer auto-grows to fit its content (typing, pasting, accepting a suggestion), capped at roughly 6 lines before it scrolls internally. Entity/mention-suggestion dropdown behavior (Enter/Tab to accept, Escape to dismiss, arrow keys to navigate) is unchanged — that interception still takes priority over the new plain-Enter-submits rule.

No backend change: message rendering already handled `\n` correctly (`white-space: pre-wrap`), and `assertMessageContent` never restricted character class.

Full diff: `git diff v1.9.0..v1.10.0`.

## [1.9.0] — 2026-07-26

**Migrations**: `0029_case_insensitive_username.js` — replaces the plain `UNIQUE` constraint on `users.username` with a unique index on `lower(username)`; fails loudly (with the colliding rows logged first) if any deployment already has two accounts differing only by case. **New env vars**: none.

Usernames are now case-insensitive at login: a user stored as `Erin` can log in as `erin`, `ERIN`, or any other casing. Fixes `FEATURE_REQUEST.md` entry 2 — previously the login lookup compared `username` case-sensitively, so a casing mismatch (autocapitalize, caps lock, a name typed differently than the account-creator used) looked identical to a wrong password, silently locking a legitimate user out with no indication of what went wrong.

Account-creation uniqueness checks (`POST /api/admin/users`, `POST /api/invitations/:token/accept`) are now case-insensitive on username too, closing the corresponding gap: fixing only the login side would have let `Erin` and `erin` exist as two distinct rows, at which point a case-insensitive login lookup becomes ambiguous about which one signs in. Email uniqueness and display casing are unchanged.

Full diff: `git diff v1.8.0..v1.9.0`.

## [1.8.0] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Thread replies now get the same `@mention` autocomplete the channel composer already had — typing `@` plus a partial username in `ThreadSidebar.jsx`'s reply box now shows matching channel-member suggestions, with the same arrow-key/Enter/Tab/Escape/mouse-click behavior. Previously the thread reply input was a bare controlled `<input>` with none of `ChannelView.jsx`'s mention machinery, so the dropdown simply never appeared there.

`ChannelView.jsx`'s `detectMentionTrigger()` and `AUTOCOMPLETE_DEBOUNCE_MS` are now exported and reused by `ThreadSidebar.jsx` rather than forked, so the two composers can't drift on what counts as "typing a mention." `ThreadSidebar.jsx` reuses the existing channel-scoped `GET /channels/:channelId/members` lookup (via `searchChannelMembers`) with the `channelId` prop it already receives — no backend change needed. Scoped to `@mentions` only; the `[[entity]]` linking autocomplete stays channel-composer-only, since it needs a `workspaceId` this sidebar doesn't currently receive and wasn't part of this request.

Full diff: `git diff v1.7.1..v1.8.0`.

## [1.7.1] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Shows the running app version in the sidebar footer. `api/client.js` adds `fetchHealth()`, a plain (non-`apiFetch`) call to `GET /health` — that route lives at the API origin's root, not under `/api`, and is already unauthenticated/CORS-enabled. `WorkspaceSidebar.jsx` fetches it once on mount and renders `v{version}` below the Direct Messages section; a fetch failure just leaves the footer blank.

Deliberately reads the *live backend's* version rather than baking the frontend's own build-time version in (the two are expected to always match, since `CLAUDE.md`'s versioning rule bumps all three `package.json`s together every release, but this proves it instead of assuming it). Verified end-to-end against the real public URL, including CORS headers (`wireservice-nginx-1` already proxies `/health` alongside `/api` and `/ws`, so no nginx change was needed).

Full diff: `git diff v1.7.0..v1.7.1`.

## [1.7.0] — 2026-07-25

**Migrations**: `0028_audit_retry_outbox.js` — additive (new table `audit_retry_outbox`, full CRUD grant, own status/attempts/dead-letter columns — a working queue, not the audit trail itself). **New env vars**: `EMBEDDING_RECONCILIATION_INTERVAL_MS` (default `300000`), `MESSAGE_SIDE_EFFECTS_RECONCILIATION_INTERVAL_MS` (default `300000`), `AUDIT_RETRY_WORKER_INTERVAL_MS` (default `30000`), `AUDIT_RETRY_WORKER_BATCH_SIZE` (default `10`), `AUDIT_RETRY_MAX_ATTEMPTS` (default `10`) — all optional with safe defaults.

Closes the two remaining "best-effort background write, no repair path" findings from the 2026-07-25 review suite (ranked #6 and #7 in `docs/reviews/2026-07-25-consolidated-meta-review.md`), batched together since both are the same underlying failure pattern examined from different review angles.

**Finding #6 (GOV-02/EFF-03) — missed queue inserts could be lost forever:**
- `search/embeddingQueue.js` adds `enqueueMissingEmbeddingJobs()`, called periodically by `search/embeddingWorker.js`'s tick (throttled to `EMBEDDING_RECONCILIATION_INTERVAL_MS`, far less often than its own poll interval): backfills `embedding_jobs` for any message with neither a job row nor a `message_embeddings` row — the one unambiguous "never enqueued" signal available, since a completed job's row is deleted on success.
- `services/messageSideEffectsQueue.js` adds the equivalent `enqueueMissingMessageSideEffectJobs()` for `message_side_effect_jobs`. This one needed a real behavior change first: unlike embeddings, there's no output table that proves "already processed" (a message can legitimately finish with zero mentions and zero linked entities), so `workers/messageSideEffectsWorker.js` now marks a finished job row `status='completed'` instead of deleting it — row *existence* (any status) is now what "was enqueued" means, so "no row at all" is finally an unambiguous signal reconciliation can act on. No retention/cleanup pass for old completed rows yet — a reasonable fast-follow, not a blocker, same as this table's own age-old growth story already applies to `messages` itself.
- That behavior change broke the existing edit-retrigger path in a way caught by the test suite, not shipped: `enqueueMessageSideEffectJobs`'s plain `ON CONFLICT DO NOTHING` used to always find no existing row (rows were deleted on success), so an edit's re-enqueue always worked; now it would silently no-op against an already-`completed` row. Fixed with a conditional upsert (`ON CONFLICT ... DO UPDATE ... WHERE status IN ('completed', 'failed')`) that resets only a job in a terminal state back to `pending`, leaving a genuinely still-`pending`/`processing` row untouched.
- Incidental bug fixed along the way, found while auditing whether re-running a `NOTIFICATION` job is safe to do more than once: `processNotificationJob` looped over every mentioned user and pushed a live WS `mention` frame unconditionally, including recipients who were already notified for that message (their DB insert was silently ignored by `ON CONFLICT DO NOTHING`, but the WS push didn't check that). In production this already meant a message edit that kept an existing `@mention` re-toasted the same recipient every time; it would also have made today's reconciliation fix unsafe. Now pushes only to recipients whose notification row was genuinely just inserted.

**Finding #7 (SEC-03/GOV-03) — streaming AI audit writes were fail-open:**
- `audit/auditService.js` adds `appendAuditEventOrEnqueueRetry()`: same as `appendAuditEvent`, but on failure it best-effort persists the event into the new `audit_retry_outbox` table (`audit/auditRetryQueue.js`) before rethrowing — every existing caller's own catch-and-log behavior around the call is unchanged, so an AI response still completes exactly as before.
- The three streaming AI routes (`routes/ai.js`: summarize, extract-tasks, workspace-digest) now call this instead of `appendAuditEvent` directly from their `onBeforeEnd` closures.
- `audit/auditRetryWorker.js` polls the outbox (same claim/retry/dead-letter shape as the other two workers) and replays each row through the real `appendAuditEvent` — a replayed event just becomes the next row in the hash chain at whatever time the retry succeeds, no special chain-ordering handling needed, since `appendAuditEvent`'s advisory lock already serializes every caller regardless of origin.

Also fixed: `tests/helpers/resetDb.js` didn't clear `audit_retry_outbox` between tests (no FK to `users` to cascade from, unlike `embedding_jobs`/`message_side_effect_jobs`, which do cascade via `messages`) — caught by a batch-size test leaking rows across tests in the same file.

Full diff: `git diff v1.6.3..v1.7.0`.

## [1.6.3] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Batched `Menu.jsx` hardening fixes from the 2026-07-25 third-party review suite (ranks #3, #10 (partial), #11, #13 in `docs/reviews/2026-07-25-consolidated-meta-review.md`), grouped because all four touch the same component:

- (A11Y-01, `2026-07-25-accessibility-review.md`) The menu container took focus and tracked a highlighted item internally, but nothing exposed which item was active to assistive tech. `Menu` now sets `aria-activedescendant` on the `role="menu"` container, pointing at a stable per-item `id` built from React's `useId()` (not a slugified `ariaLabel`, which can contain spaces and isn't guaranteed id-safe).
- (A11Y-02, partial) `Menu` items now meet the 44px Apple HIG touch-target minimum (was 40px). `EntityDetailsPanel.jsx`'s shared `removeButton` style (used by the relationship-remove button) also moves from 24x24 to 44x44; its one deliberately-smaller 18x18 inline-badge override (`EntityPicker`'s selected-value chip) is untouched, since forcing that compact inline "×" to 44px would visually break a dense chip rather than meaningfully help — not the location either review actually cited.
- (EFF-01, `2026-07-25-code-efficiency-review.md`) The keydown handler no longer rebuilds an enabled-items array with `array.reduce(...[...acc, i])` spread-copies on every keystroke.
- (MAINT-02, `2026-07-25-maintainability-review.md`) `Menu`'s keyboard-navigation math (ArrowDown/ArrowUp/Home/End, wraparound, disabled-item skipping) is now an exported pure function (`nextHighlightedIndex`), unit-tested in `Menu.test.jsx` — this project's Vitest setup has no jsdom (see `PeoplePicker.test.jsx`'s own note), so a rendered `<Menu>` can't be driven through real keydown events; extracting the pure logic is the same workaround already established for `PeoplePicker`/`EntityDetailsPanel`.

Existing Playwright e2e selectors (`[role="menuitem"]`, `aria-label`, text content) are unaffected. Full frontend unit suite (120 tests) and a production build both pass.

Full diff: `git diff v1.6.2..v1.6.3`.

## [1.6.2] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Fixed the AI concurrency queue's missing cancellation path, found by the 2026-07-25 third-party review suite (`docs/reviews/2026-07-25-security-review.md` SEC-02, `docs/reviews/2026-07-25-performance-review.md` PERF-01, `docs/reviews/2026-07-25-maintainability-review.md` MAINT-01 — independently flagged by three separate reviews, ranked #2 in `docs/reviews/2026-07-25-consolidated-meta-review.md`): every AI route already builds an `AbortController` tied to `res.on('close', ...)` and threads its `signal` through to the provider adapter call, but nothing previously passed that signal into `acquireSlot()` itself — a client that disconnected while merely *queued* (never yet in-flight) stayed in the FIFO and later consumed a real generation slot once its turn came, wasting scarce CPU-only-Ollama capacity (`LLM_MAX_CONCURRENT_REQUESTS` defaults to 1) on a response nobody would ever receive.

- `backend/src/llm/concurrencyGate.js`'s `acquireSlot()` now accepts an optional `signal`: an already-aborted signal rejects immediately without granting or queuing a slot, and a queued entry removes itself from the FIFO and rejects the moment its signal fires, without disturbing the order of the entries still waiting behind it.
- `backend/src/llm/aiService.js` and `backend/src/services/entitySummaryService.js` (the two existing callers) now pass their already-available `signal` through to `acquireSlot()`.
- New tests: `llmConcurrencyGate.test.js` covers the gate in isolation (immediate abort, queued abort, FIFO preservation around an aborted middle entry, post-grant abort as a no-op); `aiRoutes.test.js` adds a full HTTP-level test proving a disconnected-while-queued client is dequeued and never reaches `fetch()`, while the next still-connected waiter gets the freed slot in its place.

Full diff: `git diff v1.6.1..v1.6.2`.

## [1.6.1] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Fixed a privacy-boundary bug found by the 2026-07-25 third-party review suite (`docs/reviews/2026-07-25-security-review.md` SEC-01, `docs/reviews/2026-07-25-governance-audit-review.md` GOV-01, consolidated ranking in `docs/reviews/2026-07-25-consolidated-meta-review.md` finding #1): a cached entity AI summary (`entity_summaries`, migration `0026`) is generated only from channels its *generator* can read, but the cached row itself was workspace-visible to *any* reader once created — a summary generated by a broader-access member (e.g. one in a private channel) could still name/cite that channel to a later reader who was never a member of it, through both `GET /workspaces/:workspaceId/entities/:entityId/ai/summary` and the embedded `summary` field on `GET /workspaces/:workspaceId/entities/:entityId`.

- `backend/src/routes/entities.js` adds `readableSummaryFor(userId, summary)`, which re-checks the *reader's* channel membership against every channel id recorded in the summary's `citations` (already stored per-citation at generation time — no schema change needed) before either route returns it. A summary the reader can't fully see is returned as `null`, identical in shape to "no summary generated yet," rather than a 403 — consistent with this codebase's existing "404/null instead of 403" pattern for cross-boundary reads (see `entities.test.js`'s "never a 403" tests elsewhere in the same file).
- Generation itself was already correctly scoped (`referencesQuery` restricts to the generating user's own readable channels) — this fix only closes the read-back gap.
- New regression test: `entities.test.js` "a summary generated from a private-channel reference is hidden (not 403) from a workspace member outside that channel," covering both exposure routes.

Full diff: `git diff v1.6.0..v1.6.1`.

## [1.6.0] — 2026-07-25

**Migrations**: `0027_message_edits.js` — additive (new nullable `messages.edited_at` column; new `message_edits` table, insert-only — no `UPDATE`/`DELETE` grant, ever). No data loss, nothing to review before upgrading.
**New env vars**: `MESSAGE_EDIT_WINDOW_MINUTES` (default `15`, optional).

Implemented `FEATURE_REQUEST.md` backlog entry 3, "Editing a sent message, with a permanent, auditable revision history."

- `PATCH /api/channels/:channelId/messages/:messageId` — author-only (no manager/owner override), editable within a fixed window of the message's original send time (measured from `created_at`, not reset by a prior edit). Every edit inserts the pre-edit content into `message_edits` before overwriting `messages.content` — the first such row for a message is therefore exactly what was originally sent. Broadcasts the existing `message_updated` WS event (no new event type); audited as `MESSAGE_EDITED` with lengths only, never the old or new text.
- `linkMessageEntities` (`services/entityService.js`) now reconciles `message_entities` against the freshly-extracted `[[Entity]]` set on every run instead of only appending — a real correctness fix, not edit-specific: without it, an edit that removed an entity mention would leave a stale reference counting toward that entity's trending/SME/reference numbers forever. Re-triggering the existing entity-link and mention-notification side-effect jobs on edit reuses their established idempotent `onConflict(...).ignore()` semantics unmodified — a mention present before and after an edit is never double-notified; a newly added one gets a real notification.
- `GET /api/channels/:channelId/messages/:messageId/edits` — the revision history behind the "(edited)" tag, gated the same as reading the message itself (channel membership), not admin-only.
- Frontend: a new `EditableMessageContent` component (shared by `ChannelView.jsx`'s main feed and `ThreadSidebar.jsx`'s root/reply rows) adds an inline "Edit" action on the caller's own messages, an "(edited)" tag that expands to show prior versions, and no client-side mirroring of the server's edit-window check — the window is enforced server-side only, with the server's own error surfaced inline on a rejected edit.

See `PROJECT_PLAN.md` Section 11, "Editing a sent message, with a permanent, auditable revision history" (2026-07-25), for full detail.

Full diff: `git diff v1.5.1..v1.6.0`.

## [1.5.1] — 2026-07-25

**Migrations**: none. **New env vars**: none.

Fixed a real bug reported directly by the user: `GET /api/workspaces/:workspaceId/channels` decided whether a system admin saw every channel (including PRIVATE ones they hadn't joined) using `requireWorkspaceMemberOrSystemAdmin`'s `viaSystemAdminOverride` flag — which is `false` whenever the caller holds *any* genuine workspace role, by design (needed elsewhere so channel creation correctly auto-joins a genuine owner/member). Reusing that same flag for this route's read-visibility decision meant a system admin who also happened to be a plain `MEMBER` of a workspace (e.g. from an earlier self-service join) saw the same narrowed PUBLIC-plus-own-PRIVATE list an ordinary member would — strictly *less* than a non-member admin gets, which defeats the point of "system admin." Fixed by checking `isSystemAdminUser` directly for this route's visibility decision, independent of the caller's own membership status; the write-path precedence (`POST /:workspaceId/channels`'s auto-join behavior) is unchanged.

Full diff: `git diff v1.5.0..v1.5.1`.

## [1.5.0] — 2026-07-25

**Migrations**: none.
**New env vars**: `KNOWLEDGE_EXPLORER_TRENDING_WINDOW_DAYS` (default `30`, optional).

Implemented `FEATURE_REQUEST.md` backlog entry 2, "Workspace-scoped Knowledge Explorer for the `[[Entity]]` graph" — the trending/SME/citation-history/cross-channel-navigation slice entry 4 (now shipped as "Entity pages as a lightweight knowledge base," `v1.4.0`) deliberately left out.

- `GET /api/workspaces/:workspaceId/entities/trending?windowDays=&limit=&offset=` — a workspace-wide leaderboard of `[[Entity]]` mentions, reusing the existing caller-scoped `channel_members` join so an entity referenced only in a channel the caller can't read never appears (not even with a zero count).
- `GET /api/workspaces/:workspaceId/entities/:entityId/experts?limit=` — the same join grouped by contributor instead of entity, surfacing who's actually referenced a given entity, with the identical privacy guarantee.
- `GET /api/workspaces/:workspaceId/entities/:entityId/references` (and the entity detail response) now embed `parentMessage` on a threaded reference, mirroring `GET /api/search/semantic`'s existing shape — no second fetch needed to show thread context.
- `EntityDetailsPanel.jsx`: descriptions now render through the same Markdown pipeline as message content; a new Subject Matter Experts section; a "View context" action on each reference that switches workspace/channel and opens the right thread.
- New `KnowledgeExplorerPanel.jsx`, reachable via a per-workspace sidebar trigger, showing the Trending list — clicking a row opens the existing entity detail panel.
- New `entityTrendingLimiter`/`entityExpertsLimiter` rate limiters. No new audit events (unaudited, read-only, no LLM cost — matches every other plain entity read).

See `PROJECT_PLAN.md` Section 11, "Workspace-scoped Knowledge Explorer for the `[[Entity]]` graph: trending, Subject Matter Experts, citation history, and View Context" (2026-07-25), for full detail.

Full diff: `git diff v1.4.0..v1.5.0`.

## [1.4.0] — 2026-07-24

**Migrations**: `0026_entity_metadata_relationships_summaries.js` — additive (four new nullable/defaulted columns on `entities`: `owner_id`, `status`, `tags`, `reference_url`; two new tables, `entity_relationships` and `entity_summaries`). No data loss, nothing to review before upgrading.
**New env vars**: none.

Implemented `FEATURE_REQUEST.md` backlog entry 4, "Entity pages as a lightweight knowledge base" — the scope left over after entry 2 (Knowledge Explorer, still `Proposed`) covers trending/SME/citation-history: editable entity metadata, `entity_relationships`, and an AI-generated "What we know" summary.

- `PATCH /api/workspaces/:workspaceId/entities/:entityId` — any workspace member can edit an entity's `description`, `aliases` (collision-checked against other entities in the same workspace), `status` (`ACTIVE`/`DEPRECATED`/`ARCHIVED`), `tags`, `ownerId` (must be a workspace member), and an optional `referenceUrl`. Audited as `ENTITY_METADATA_UPDATED` (field names and counts only, never the description/alias/tag text itself).
- `POST`/`DELETE /api/workspaces/:workspaceId/entities/:entityId/relationships` — a fixed relationship-type vocabulary (`DEPENDS_ON`/`OWNED_BY`/`RELATED_TO`/`BLOCKS`/`PART_OF`), workspace-isolated, self-relationships and duplicates rejected. Audited as `ENTITY_RELATIONSHIP_CREATED`/`ENTITY_RELATIONSHIP_REMOVED`.
- `GET`/`POST /api/workspaces/:workspaceId/entities/:entityId/ai/summary` — an AI-generated "What we know" summary built only from the caller's channel-membership-authorized references (the same join `referencesQuery` already restricts search/detail to), stored as a revision history (`entity_summaries`, never overwritten) with provider/prompt-version metadata and a citation list. `POST` regenerates; `GET` reads the latest cached revision with no LLM call. Rate-limited (`aiEntitySummaryRateLimiter`) and audited as `AI_ENTITY_SUMMARY_REQUESTED`.
- `GET /api/workspaces/:workspaceId/entities/:entityId` now also returns `relationships` (bidirectional, both entities' detail responses stay in sync), `linkedActionItems` (inline Markdown checkbox tasks parsed from the same authorized, bounded reference set — no second query), and the cached `summary`.
- Explicitly out of scope for this entry, flagged rather than silently skipped: "pinned messages" and "linked decisions," both named in the original design, have no backing feature anywhere in this codebase yet (no pinning feature; entry 3's `decision` concept is still `Proposed`) — nothing to surface until those exist.
- Frontend: `EntityDetailsPanel.jsx` gained an inline metadata edit form, a relationships list with an entity-search-and-add control, a linked-action-items list, and a "What we know" section with a Generate/Regenerate button.

See `PROJECT_PLAN.md` Section 11, "Entity pages as a lightweight knowledge base: editable metadata, entity_relationships, and AI-generated summaries" (2026-07-24), for full detail.

Full diff: `git diff v1.3.3..v1.4.0`.

## [1.3.3] — 2026-07-24

**Migrations**: none. **New env vars**: none.

Fixed a real bug in the Admin Analytics dashboard, reported directly by the user: with `scope` set to "Workspace" (or "User," on the Sentiment Trends tab), the picker dropdown was always empty — nothing was selectable. Root cause: `AdminAnalyticsPanel.jsx` requested `limit: 200` for its workspace and user pickers, exceeding the backend's real `MAX_PAGE_LIMIT` of `100` (`validation.js`); the resulting `400` was silently swallowed into an empty list with no visible error. Fixed by requesting `limit: 100` (the actual server ceiling) and no longer swallowing a picker-load failure silently — a real error now renders in the panel instead of a dropdown that looks empty for no visible reason.

Full diff: `git diff v1.3.2..v1.3.3`.

## [1.3.2] — 2026-07-24

**Migrations**: none. **New env vars**: none.

`scripts/backfill-sentiment-scores.mjs` (added in `1.3.1`) is now wired into `scripts/airgap-upgrade.sh` as a new, non-fatal Phase G — so any enclave upgrading through `v1.3.0` for the first time gets the pre-existing-message sentiment backfill automatically, instead of needing an operator to remember and run it by hand. The script itself gained a fast no-op path (skips both anchor-embedding calls entirely when there's nothing left to backfill) so it's cheap to run unconditionally on every future upgrade. See `PROJECT_PLAN.md` Section 11, "Wire the sentiment backfill into scripts/airgap-upgrade.sh" (2026-07-24), including the honest caveat that this new phase hasn't yet been exercised in a real end-to-end upgrade rehearsal.

Full diff: `git diff v1.3.1..v1.3.2`.

## [1.3.1] — 2026-07-24

**Migrations**: none. **New env vars**: none.

The previous release's sentiment-trend feature only scores a message as a side effect of its embedding job, and that job is only ever enqueued at message-creation time — every message that already existed before `v1.3.0` shipped had already been embedded (and its job row deleted) long before, so none of them would ever get a sentiment score without help. New `scripts/backfill-sentiment-scores.mjs` (kept in the repo — any other deployment upgrading past `v1.3.0` hits the identical gap): a set-based, safely-re-runnable SQL backfill computed directly from each message's already-stored embedding via pgvector's `<=>` operator, no re-embedding required. Run once against this environment's real database: 87 pre-existing messages backfilled. See `PROJECT_PLAN.md` Section 11, "Backfill sentiment scores for messages that predate the sentiment feature" (2026-07-24), for full detail, including a real concurrency-gate bug found and fixed while writing it.

Full diff: `git diff v1.3.0..v1.3.1`.

## [1.3.0] — 2026-07-24

**Migrations**: `0025_message_sentiment_scores.js` — additive (new table, no changes to existing tables). No data loss, nothing to review before upgrading.
**New env vars** (all optional, safe defaults): `ADMIN_ANALYTICS_MIN_SHARED_CHANNELS` (default `2`), `SENTIMENT_POSITIVE_ANCHORS`/`SENTIMENT_NEGATIVE_ANCHORS` (default anchor phrases), `SENTIMENT_MIN_BUCKET_MESSAGES` (default `5`).

- Added the two remaining Admin Analytics Dashboard tabs (`FEATURE_REQUEST.md`, originally ranked entries 5 and 6): "Collaboration" (`GET /api/admin/analytics/collaboration/membership-graph` — structural channel-membership overlap between users; `.../interaction-trend` — reply-based cross-person interaction volume over time) and "Sentiment Trends" (`GET /api/admin/analytics/sentiment-trend` — an approximate per-bucket tone average derived from the embedding already computed for semantic search, never a second LLM call). Both are system-admin-only, metadata/embedding-only reads — never message content — and structurally exclude DM/group-DM channels, same as the Activity tab. `scope=user` on the sentiment endpoint (the one variant that's individual tone-monitoring rather than a many-person average) is audited; every other route/scope is not. See `PROJECT_PLAN.md` Section 11, "Admin Analytics Dashboard: collaboration structure and interaction trend, and aggregate semantic/sentiment trend" (2026-07-24), for full detail.

Full diff: `git diff v1.2.0..v1.3.0`.

## [1.2.0] — 2026-07-24

**Migrations**: `0024_admin_analytics_index.js` — additive (new index, `idx_messages_created_at`, no column/table changes). No data loss, nothing to review before upgrading.
**New env vars**: none (`adminAnalyticsLimiter`'s 30 req/60s ceiling is a fixed constant, not env-configurable, matching `tasks.js`'s own `MAX_TASK_DASHBOARD_WINDOW_DAYS` precedent).

- Added a system-admin-only Admin Analytics dashboard (`FEATURE_REQUEST.md` entry 5, "Admin Analytics Dashboard — activity and engagement metrics"): `GET /api/admin/analytics/activity` (message/active-user counts bucketed by day or week, scoped to an organization/workspace/channel or everything a system admin administers) and `GET /api/admin/analytics/dormant-channels` (channels with no top-level message in N days, computed live from each channel's own last-activity timestamp, never a stored flag). Both are pure aggregate reads over `messages.created_at`/`channel_id`/`user_id` and `channel_members` — never `messages.content` — and structurally exclude DM/group-DM channels (`channels.workspace_id IS NOT NULL`). New `AdminAnalyticsPanel.jsx`, reachable from the Admin hub. See `PROJECT_PLAN.md` Section 11, "Admin Analytics Dashboard: activity and engagement metrics" (2026-07-24), for full detail, including a real Postgres `GROUP BY`/parameter-binding bug found and fixed during implementation.

Full diff: `git diff v1.1.1..v1.2.0`.

## [1.1.1] — 2026-07-24

**Migrations**: none. **New env vars**: none.

Two real bugs in `scripts/airgap-upgrade.sh` found by actually rehearsing it end-to-end against an isolated throwaway stack (a real v1.0.0 install upgraded to a real v1.1.0, on the same host as a live deployment) — the "not yet rehearsed" gap `v1.1.0`'s entry and `RUNBOOK.md` both flagged honestly instead of glossing over, closed the same day:

- The script hardcoded `http://localhost:8101` for every health check instead of respecting `BACKEND_HOST_PORT` (`docker-compose.yml`'s own port-remap variable). On a host already running a real deployment on the default port, a rehearsal remapping the port to avoid colliding would have had every check silently query the *other*, real instance instead of the rehearsal stack — a false-positive/false-negative risk, not just an inconvenience. Fixed: `BASE_URL` is now resolved from `BACKEND_HOST_PORT` once `.env` is loaded, and every check uses it.
- The preflight's "read the currently-running version off `GET /health`" step has no fallback for a backend that predates the `version` field entirely — which is exactly `v1.0.0`, since that field didn't exist until `v1.1.0`. Unfixed, this would have hard-failed the very first upgrade any real enclave ever runs. Fixed: an explicit `ASSUME_PREVIOUS_VERSION` env var lets the operator confirm what's running when `/health` can't report it itself — required, not guessed, same "fail closed, make the operator say it out loud" posture `CONFIRM_MAJOR_UPGRADE` already uses.

Both were found and fixed *before* being exercised for real, then the same rehearsal was re-run clean end-to-end: 22→23 migrations applied, grants re-verified, all pre-existing data (users, workspace, channel, messages, a DM, and its message) confirmed byte-for-byte unchanged by direct row-count and content comparison before/after, and the new `v1.1.0` auto-archive feature itself exercised against that pre-existing DM (backdating it past a newly-set threshold correctly excluded it from `GET /api/direct-messages`) — proof the feature works on data that predates it, not just on data created after upgrading. See `PROJECT_PLAN.md` Section 11, "Rehearsing the enclave upgrade script end-to-end" (2026-07-24), for the full walkthrough.

Full diff: `git diff v1.1.0..v1.1.1`.

## [1.1.0] — 2026-07-24

**Migrations**: `0023_dm_auto_archive.js` — additive (new nullable `users.dm_auto_archive_days` column). No data loss, nothing to review before upgrading.
**New env vars** (both optional, safe defaults): `DM_AUTO_ARCHIVE_DEFAULT_DAYS` (default `90`), `DM_AUTO_ARCHIVE_MAX_DAYS` (default `3650`).

- Added ephemeral direct messages and group DMs via a per-user auto-archive threshold (`FEATURE_REQUEST.md` entry 2). `DIRECT`/`GROUP_DM` channels a user hasn't touched in a while quietly drop out of that user's own channel list — never deleted, never hidden from a DBA, always recomputed live from the channel's actual last-activity timestamp — and a new message brings a dormant one right back automatically. New self-service `PATCH /api/auth/me/dm-settings` lets each user set their own threshold (`0` = never archive). See `PROJECT_PLAN.md` Section 11, "Ephemeral direct messages and group DMs via per-user auto-archive" (2026-07-24), for full detail.
- Added this file, `scripts/airgap-upgrade.sh`, and a `version` field on `GET /health` — the tooling this changelog itself depends on. See `RUNBOOK.md`'s "Enclave Upgrade" section.

Full diff: `git diff v1.0.0..v1.1.0` (or `v1.0.0...v1.1.0` for just this range's commits).

## [1.0.0] — 2026-07-23

Baseline. The version installed in the air-gapped enclave as of 2026-07-24, tagged retroactively at commit `fbbf9bd` (the last commit before this file started tracking releases) once that fact was confirmed directly by the enclave operator — this repo has no independent visibility into what's physically running there. No changelog entries before this point; everything prior lives in `PROJECT_PLAN.md` Section 11's full implementation log, uncategorized by release.
