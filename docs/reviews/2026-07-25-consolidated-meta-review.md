# Consolidated Meta-Review — Silent Whisper (2026-07-25 Review Suite)

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`
**Current app version (as of last progress update below)**: `v1.7.0`
**Source documents**: `2026-07-25-security-review.md`, `2026-07-25-governance-audit-review.md`, `2026-07-25-enclave-readiness-review.md`, `2026-07-25-performance-review.md`, `2026-07-25-accessibility-review.md`, `2026-07-25-maintainability-review.md`, `2026-07-25-code-efficiency-review.md`

## Progress at a glance

| Status | Count | Ranks |
|---|---|---|
| ✅ Fixed | 7 | #1, #2, #3, #6, #7, #10, #13 |
| 🟡 Partially fixed | 1 | #11 |
| 🔵 Open, tracked elsewhere (not code work) | 2 | #4, #5 |
| ⚪ Open, no action taken yet | 3 | #8, #9, #15 |
| ⏭️ Recommended close, not fixed | 2 | #12, #14 |
| ⚫ Informational, no action planned | 1 | #16 |

(16 findings total. #3, #10, and #13 were all closed in the same `v1.6.3` commit — see the batch log below.)

**Next up by rank**: #4/#5 aren't code work (see their entries — they need a separate rehearsal host and real GPU hardware respectively, already tracked in `SHIPMENT_PLAN.md`). The next actionable code item by rank is **#8** (reply-count query), or pick up **#9** (`ChatShell.jsx` refactor) if you want the bigger, riskier one out of the way. #12/#14 are recommended to close rather than fix — see their entries for why.

## Batch/commit log

| Version | Tag | Findings closed | Commit |
|---|---|---|---|
| `v1.6.1` | `v1.6.1` | #1 | `Fix: entity AI summary cache leaked across channel-access boundaries` |
| `v1.6.2` | `v1.6.2` | #2 | `Fix: AI concurrency queue had no cancellation path for disconnected clients` |
| `v1.6.3` | `v1.6.3` | #3, #10, #13, #11 (partial — Menu only) | `Fix: Menu.jsx accessibility, touch-target, and efficiency batch` |
| `v1.7.0` | `v1.7.0` | #6, #7 | `Add reconciliation for missed queue inserts and an audit write retry outbox` |

**Bonus fix, not one of the original 16 findings**: while closing #6, verifying it was safe to make `message_side_effect_jobs` reprocessing idempotent surfaced a real live bug — `processNotificationJob` was pushing a duplicate WS "mention" toast to already-notified recipients every time a message was edited (not just to newly-mentioned ones). Fixed in the same `v1.7.0` commit. See that entry's detail section below and the `v1.7.0` CHANGELOG entry for the full writeup.

All four releases above are committed, tagged, pushed to `main`, and deployed live (verified via `/health` reporting the new version and, for `v1.7.0`, a direct query confirming the new `audit_retry_outbox` table exists in production). Full test suite (729 backend tests + 120 frontend tests) passing as of `v1.7.0`.

## Methodology

Seven independent reviews ran against the same `v1.6.0` snapshot from different lenses (security, governance/audit, enclave readiness, performance, accessibility, maintainability, code efficiency), producing 21 raw findings. Several reviews independently flagged the same underlying defect from different angles. This document:

1. **Deduplicates** raw findings that describe the same root cause into single entries (21 raw → 16 unique).
2. **Verifies** every finding against current source — each one below was checked by reading the cited file/line range directly, not taken on the source review's word alone.
3. **Re-ranks** by actual severity/impact, which sometimes differs from the source reviews' own per-domain severity label (e.g., a confidentiality boundary break is ranked above resource-exhaustion issues even though both were independently labeled "Medium").

Every finding below was **CONFIRMED** against source as of the original 2026-07-25 review pass. None were found to be inaccurate or already fixed at that time. Status markers below reflect what's happened *since* — re-verify against current source before resuming work, per this doc's own standing advice (memories/source citations age).

## Summary

| Rank | Status | Finding | Consolidated Severity | Corroborating reviews |
|---|---|---|---|---|
| 1 | ✅ Fixed `v1.6.1` | Entity summary cache leaks across channel-access boundaries | **Medium (confidentiality)** | Security, Governance |
| 2 | ✅ Fixed `v1.6.2` | AI concurrency queue has no cancellation on client disconnect | **Medium (availability)** | Security, Performance, Maintainability |
| 3 | ✅ Fixed `v1.6.3` | Menu active item not exposed to assistive tech (`aria-activedescendant`) | **Medium (a11y)** | Accessibility |
| 4 | 🔵 Open (not code work) | Air-gapped installer never rehearsed as a literal clean-host run | **Medium (operational, tracked)** | Enclave Readiness |
| 5 | 🔵 Open (not code work) | vLLM real-hardware verification still blocked / risk-accepted | **Medium (operational, tracked)** | Enclave Readiness |
| 6 | ✅ Fixed `v1.7.0` | Best-effort queue inserts can permanently drop derived records | **Low** | Governance, Code Efficiency |
| 7 | ✅ Fixed `v1.7.0` | Streaming AI audit writes are fail-open | **Low** | Security, Governance |
| 8 | ⚪ Open | Message feed reply counts use a per-row correlated subquery | **Low** | Performance |
| 9 | ⚪ Open | `ChatShell.jsx` owns too many workflow responsibilities | **Low** | Maintainability |
| 10 | ✅ Fixed `v1.6.3` | Compact controls fall below 44px HIG touch-target minimum | **Low** | Accessibility |
| 11 | 🟡 Partially fixed `v1.6.3` | Menu/Sheet keyboard-and-focus behavior lacks focused unit tests | **Low** | Maintainability |
| 12 | ⏭️ Recommend close | Worker batches are claimed in batches but processed serially | **Low (deliberate tradeoff)** | Performance |
| 13 | ✅ Fixed `v1.6.3` | Menu keydown handler reallocates an array on every keystroke | **Low (trivial)** | Code Efficiency |
| 14 | ⏭️ Recommend close | `fetchAllPages()` resolves only after accumulating every page | **Low (partially mitigated)** | Code Efficiency |
| 15 | ⚪ Open | Frontend image is baked to one enclave hostname | **Low (documented, has fast-follow)** | Enclave Readiness |
| 16 | ⚫ Informational | Known `--text-3` / dark active-row contrast debt | **Informational (pre-existing)** | Accessibility |

---

## Detailed Findings

### 1. Entity summary cache leaks across channel-access boundaries
**Status: ✅ Fixed in `v1.6.1`**
**Severity: Medium (confidentiality/authorization boundary) — highest-impact finding in the suite**
**Sources**: `SEC-01` (security review), `GOV-01` (governance review)
**Location**: `backend/src/routes/entities.js:682-751` and `:373-415`

**Verification**: Confirmed directly. `POST .../ai/summary` builds a summary from `referencesQuery()`, which *is* correctly scoped to channels the generating user can read. But the resulting row is stored with no record of who may read it back, and `loadLatestSummary()` (`entities.js:222-224`) does an unscoped `where({ entity_id })` fetch with no join back to the reader's channel memberships. `serializeSummary()` (`entities.js:79-90`) returns `citations` verbatim. This means:
- The dedicated `GET .../ai/summary` route returns the cached summary to *any* workspace member.
- The main entity detail route (`GET /workspaces/:workspaceId/entities/:entityId`, `entities.js:403-415`) *also* embeds `serializeSummary(latestSummary)` in its response — a second, previously unflagged exposure path through the same underlying gap.

**Why ranked #1 despite a "Medium" label in both source reviews**: this is the only finding in the set that is an actual unauthorized-disclosure bug — private-channel-derived content crossing a real authorization boundary to other workspace members — rather than a resource-exhaustion, operational, or code-quality concern. Two independent review lenses (security, governance) converged on the identical root cause and file, which increases confidence this is real and not a false positive. Given `CLAUDE.md`'s explicit rule that authorization must be enforced server-side on every call and that private channel/DM content must never leak through AI tooling, this should be treated as the top remediation priority.

**Fix shipped**: `readableSummaryFor()` re-checks the reader's channel membership against every channel a cached summary cites before either exposure route returns it; a summary the reader can't fully see now returns `null` (same shape as "no summary yet") instead of leaking it. New regression test in `entities.test.js` covers both exposure paths.

---

### 2. AI concurrency queue has no cancellation on client disconnect
**Status: ✅ Fixed in `v1.6.2`**
**Severity: Medium (availability) — triple-corroborated**
**Sources**: `SEC-02` (security/DoS), `PERF-01` (performance), `MAINT-01` (maintainability)
**Location**: `backend/src/llm/concurrencyGate.js:33-46`, `backend/src/llm/aiService.js:65-82`

**Verification**: Confirmed. `acquireSlot(maxConcurrent, { onQueued })` takes no `signal` parameter and stores only a bare `resolve` callback in `queue`; there is no path to remove an entry before it's granted a slot. `runCompletion()`/`runStreamingCompletion()` in `aiService.js` do pass an `AbortSignal` to the *adapter* call once a slot is acquired, but that's after the wait, not during it.

**Materiality check**: `backend/src/config.js` defaults `LLM_MAX_CONCURRENT_REQUESTS=1` and `AI_QUEUE_MAX_DEPTH=8`. With a default concurrency of exactly 1, an abandoned request that reaches the front of the queue occupies the *only* generation slot for a full CPU-only Ollama completion before anyone notices — this is a real, not theoretical, capacity risk under the project's own stated single-instance/CPU-only deployment target, not just an edge case.

**Why ranked #2**: independently rediscovered by three review lenses looking at three different concerns (DoS, throughput, and API design) is strong convergent evidence, and the default config amplifies rather than bounds the impact. Ranked below finding #1 because impact is capacity waste/latency, not data disclosure.

**Fix shipped**: `acquireSlot()` now accepts an optional `signal` — an already-aborted signal rejects immediately without queuing, and a queued entry removes itself from the FIFO on abort without disturbing the order behind it. Wired through both callers (`aiService.js`, `entitySummaryService.js`). 5 new tests: 4 unit-level in `llmConcurrencyGate.test.js`, 1 full HTTP-level integration test in `aiRoutes.test.js` proving a disconnected-while-queued client never reaches `fetch()`.

---

### 3. Menu active item not exposed to assistive tech
**Status: ✅ Fixed in `v1.6.3`**
**Severity: Medium (accessibility)**
**Source**: `A11Y-01`
**Location**: `frontend/src/components/Menu.jsx:164-181`

**Verification**: Confirmed. The `role="menu"` container (`menuRef`) receives focus and `tabIndex={-1}`; `highlightedIndex` is tracked in React state and drives only a visual `background` style (`styles.item`, line 147). No `aria-activedescendant` attribute exists anywhere in the file, and menu items are plain `<div role="menuitem">` elements with no `id` for such an attribute to reference. A screen reader user navigating with arrow keys gets no announcement of which item is active.

**Fix shipped**: `Menu` now sets `aria-activedescendant` on the `role="menu"` container, pointing at a stable per-item `id` built from React's `useId()` (not a slugified `ariaLabel`, which can contain spaces and isn't guaranteed id-safe). Shipped in the same commit as #10 and #13 below, plus the Menu half of #11, since all four touch the same file — see the batch log above.

---

### 4. Air-gapped installer never rehearsed as a literal clean-host run
**Status: 🔵 Open — not code work, tracked in `SHIPMENT_PLAN.md`**
**Severity: Medium (operational — already tracked, not a new discovery)**
**Source**: `ENCLAVE-01`
**Location**: `docs/plans/active/SHIPMENT_PLAN.md:103` (Section 1.3 status), `scripts/airgap-install.sh`

**Verification**: Confirmed accurate. `SHIPMENT_PLAN.md` itself documents that every phase's logic has been verified against isolated throwaway containers, but a true single-process, start-to-finish run has not happened because this host is Silent Whisper's live production deployment and its hardcoded ports collide with production containers. `README.md`'s "Known issues" section independently confirms this is a formally accepted risk for v1.0, with a documented playbook.

**Why ranked here**: this is a real go-live blocker, but it is already known, already tracked with a remediation plan, and explicitly called out by the enclave-readiness review itself as "not a rediscovered defect." It's ranked below findings 1-3 because there's no new information here for the team to act on beyond what `SHIPMENT_PLAN.md` already says — the review confirms rather than surfaces the gap.

**Why not picked up in this pass**: this needs a genuinely separate host (this dev/test host doubles as production and its ports collide), not a code change — nothing in an editing session can close it. Track via `SHIPMENT_PLAN.md` directly.

---

### 5. vLLM real-hardware verification still blocked / risk-accepted
**Status: 🔵 Open — not code work, tracked in `SHIPMENT_PLAN.md`**
**Severity: Medium (operational — already tracked)**
**Source**: `ENCLAVE-02`
**Location**: `docs/plans/active/SHIPMENT_PLAN.md:80` (referenced), `README.md` Known Issues, `scripts/airgap-install.sh:233-411`

**Verification**: Confirmed. `README.md` independently states `LLM_PROVIDER=vllm` "has never been exercised against a real vLLM instance (this test host has no GPU)" and calls this "a formally accepted risk for v1.0." The installer's Phase F checks (model list, completion, streaming, embedding dimension, concurrency) exist in `airgap-install.sh` as described, but by definition haven't run against real hardware yet.

**Why ranked below #4**: same "already tracked, accepted risk" category as finding 4, but scoped only to the vLLM/AI path rather than blocking the entire install, so a failure here is more contained.

**Why not picked up in this pass**: needs real GPU hardware, which doesn't exist on this host. Same as #4 — not something an editing session can close.

---

### 6. Best-effort queue inserts can permanently drop derived records
**Status: ✅ Fixed in `v1.7.0`**
**Severity: Low**
**Sources**: `GOV-02` (governance), `EFF-03` (code efficiency)
**Location**: `backend/src/services/messageSideEffectsQueue.js:11-31`, `backend/src/search/embeddingQueue.js:10-22`

**Verification**: Confirmed. Both `enqueueEmbeddingJob()` and `enqueueMessageSideEffectJobs()` wrap their insert in `try/catch`, log via `console.error`, and swallow the error — by explicit design, per the in-code comments, so a transient insert failure never fails the already-succeeded message send. But there genuinely is no reconciliation path: a message that loses its queue-insert race never gets mention notifications, entity links, embeddings, or sentiment scoring unless an operator notices logs and manually repairs it.

**Ranked above the audit fail-open finding (#7)** because the blast radius is broader — user-facing functionality (search, mentions, entity graph) rather than just an audit-trail gap — and it's corroborated by two review lenses examining different concerns (compliance and efficiency) converging on the same two files.

**Fix shipped**: `enqueueMissingEmbeddingJobs()`/`enqueueMissingMessageSideEffectJobs()` added, called periodically (throttled, ~5 min) by their respective workers to backfill jobs whose enqueue insert failed. Required changing `message_side_effect_jobs` to mark completed rows `status='completed'` instead of deleting them — there's no output table to prove "already processed" for a message with zero mentions/entities, so row *existence* had to become the "was this enqueued" signal instead. That change broke the existing message-edit re-trigger path (a plain `ON CONFLICT DO NOTHING` silently no-opped against an already-`completed` row); fixed with a conditional upsert that resets only terminal-state rows back to `pending`. See the `v1.7.0` CHANGELOG entry for full detail, including a real, independently-discovered duplicate-WS-notification bug this work surfaced and fixed along the way (`processNotificationJob` was re-toasting already-notified recipients on every message edit). Deliberately no retention/cleanup pass yet for old `completed` rows — noted as an accepted, undocumented-blocker tradeoff, matching this project's own established pattern for that kind of call (see #15's identical shape).

---

### 7. Streaming AI audit writes are fail-open
**Status: ✅ Fixed in `v1.7.0`**
**Severity: Low**
**Sources**: `SEC-03` (security), `GOV-03` (governance)
**Location**: `backend/src/llm/aiService.js:118-124`

**Verification**: Confirmed. `runStreamingCompletion()` calls `onBeforeEnd(result)` inside a `try/catch` that only `console.error`s on failure — the response still completes successfully with no corresponding audit row. This is a narrow window (only triggers on a DB failure occurring after generation completes but before the audit write), which is why it's Low rather than Medium, but it is a real, reproducible gap in the audit chain's completeness guarantee that `PROJECT_PLAN.md`/`CLAUDE.md` treat as important.

**Fix shipped**: new `audit_retry_outbox` table (migration `0028`) + `audit/auditRetryWorker.js`. `audit/auditService.js`'s new `appendAuditEventOrEnqueueRetry()` best-effort persists a failed event into the outbox before rethrowing (every existing caller's own catch-and-log behavior is unchanged); the three streaming AI routes in `routes/ai.js` now call it instead of `appendAuditEvent` directly. The worker polls the outbox and replays each row through the real `appendAuditEvent` — a replayed event just becomes the next row in the hash chain whenever the retry succeeds, no special chain-ordering handling needed, since `appendAuditEvent`'s advisory lock already serializes every caller regardless of origin. Shipped together with #6 since both are the same "best-effort background write, no repair path" pattern — see the batch log above.

---

### 8. Message feed reply counts use a per-row correlated subquery
**Status: ⚪ Open — no action taken yet**
**Severity: Low**
**Source**: `PERF-02`
**Location**: `backend/src/routes/messages.js:54-75`

**Verification**: Confirmed — the `reply_count` column is computed via `(select count(*) from messages as replies where replies.parent_message_id = messages.id)` per returned row, exactly as described. Mitigating factor not fully credited in the source finding: there is a dedicated partial index (`idx_messages_threading`, referenced in the code's own comment) backing this lookup, so the real-world cost is one indexed lookup per row rather than a full scan — a genuine but modest inefficiency, not a query-plan hazard.

**Suggested next step**: standalone, self-contained fix — swap the correlated subquery for a `GROUP BY`-aggregated `LEFT JOIN` (the source review's own remediation snippet is directly usable). Small enough to be its own single-commit PATCH release; doesn't need batching with anything else.

---

### 9. `ChatShell.jsx` owns too many workflow responsibilities
**Status: ⚪ Open — no action taken yet**
**Severity: Low**
**Source**: `MAINT-03`
**Location**: `frontend/src/components/ChatShell.jsx` (1281 lines total)

**Verification**: Confirmed and, if anything, understated — the file is 1281 lines with 38 `useState` declarations and 71 total hook calls (`useState`/`useEffect`/`useCallback`/`useRef` combined), coordinating channel selection, WebSocket reconciliation, mentions, notifications, tasks, DMs, entity panels, digest panels, and thread state exactly as described. This is real maintainability debt with a large future blast radius, but it's not causing any current defect, so Low is appropriate.

**Suggested next step**: the largest, riskiest remaining item — a real refactor (extracting narrow hooks per the source review's own sketch: `useChannelState`, `useRealtimeReconciliation`, `usePanels`, etc.), not a drive-by fix. Deserves its own dedicated session with careful regression testing (this project has no jsdom-based component rendering tests — see #11 — so a `ChatShell` refactor's correctness will lean heavily on the Playwright e2e suite; run `frontend/e2e/workflows.spec.js` before and after, not just unit tests). Do not batch with anything else.

---

### 10. Compact controls fall below 44px HIG touch-target minimum
**Status: ✅ Fixed in `v1.6.3`**
**Severity: Low**
**Source**: `A11Y-02`
**Location**: `frontend/src/components/EntityDetailsPanel.jsx:171-182`, `frontend/src/components/Menu.jsx:139-149`

**Verification**: Confirmed. `EntityDetailsPanel.jsx`'s `removeButton` style is `minWidth: 24, minHeight: 24`. `Menu.jsx`'s item style sets `minHeight: 40`. Both are below the 44×44pt Apple HIG target as claimed.

**Fix shipped**: both bumped to 44px. `EntityDetailsPanel.jsx`'s *other*, deliberately-smaller 18×18 inline-badge remove button (`EntityPicker`'s selected-value chip, a location the source review didn't actually cite) was left alone — forcing that compact inline "×" to 44px would visually break a dense chip for no real accessibility benefit.

---

### 11. Menu/Sheet keyboard-and-focus behavior lacks focused unit tests
**Status: 🟡 Partially fixed in `v1.6.3` — Menu only, Sheet still untested**
**Severity: Low**
**Source**: `MAINT-02`
**Location**: `frontend/src/components/Menu.jsx`, `frontend/src/components/Sheet.jsx`

**Verification**: Confirmed by directory search — the frontend test directory contains no `Menu.test.*` or `Sheet.test.*` file (existing component tests include `EntityDetailsPanel.test.jsx`, `WorkspaceSidebar.test.jsx`, `PeoplePicker.test.jsx`, `ChannelView.test.jsx`, `channels.test.jsx`, but no test targeting either primitive). The hand-rolled keyboard/focus logic in both files (confirmed present when verifying findings 3 and 10 above) is consequently unverified by automated tests.

**Fix shipped (Menu only)**: this project's Vitest setup has no jsdom, so a rendered `<Menu>` can't be driven through real keydown events (same constraint `PeoplePicker.test.jsx`/`EntityDetailsPanel.test.jsx` already worked around). `Menu.jsx`'s keyboard-navigation math was extracted into an exported pure function (`nextHighlightedIndex`) and unit-tested in the new `Menu.test.jsx` — 13 tests covering wraparound, disabled-item skipping, Home/End, no-op keys.

**Still open**: `Sheet.jsx` (Escape close, Tab-wrap focus trap, `role="dialog"`/`aria-modal`) has no equivalent extraction or tests yet. Same jsdom constraint applies — would need the same "extract the pure logic" treatment, and `Sheet`'s focus-trap logic is more DOM-dependent (`document.activeElement`, tab-order queries) than `Menu`'s pure index math was, so this may be a harder extraction, not a copy-paste of the `Menu` approach. Worth scoping before starting.

---

### 12. Worker batches are claimed in batches but processed serially
**Status: ⏭️ Recommended to close, not fixed**
**Severity: Low — weaker finding than stated; deliberate tradeoff, not an oversight**
**Source**: `PERF-03`
**Location**: `backend/src/search/embeddingWorker.js:103-121`, `backend/src/workers/messageSideEffectsWorker.js:173-189`

**Verification**: Confirmed that both workers use `for (const job of jobs) { await processJob(...) }` (sequential, `eslint-disable-next-line no-await-in-loop`) rather than `Promise.all`. However, both call sites carry an explicit in-code comment explaining *why*: each `processJob` call already contends for a shared concurrency gate (embedding) or the DB/WS registry (side effects), so parallelizing the outer loop wouldn't add real throughput and would let one bad batch overwhelm the shared resource. This is a reasoned design decision the review's own "Architectural Wins" section elsewhere credits the codebase for (conservative, resource-friendly queue processing) — flagging it as an inefficiency is defensible as a "worth revisiting" note but should not be read as an unintentional bug.

**Recommendation stands**: close without code changes unless a real throughput problem shows up in practice.

---

### 13. Menu keydown handler reallocates an array on every keystroke
**Status: ✅ Fixed in `v1.6.3`**
**Severity: Low (trivial)**
**Source**: `EFF-01`
**Location**: `frontend/src/components/Menu.jsx:85`

**Verification**: Confirmed: `items.reduce((acc, item, i) => (item.disabled ? acc : [...acc, i]), [])` runs on every `keydown` inside `handleMenuKeyDown`. Real, but menus in this app are short-lived and small (confirmed by reading the surrounding file), so the practical impact is negligible — correctly rated Low by the source review.

**Fix shipped**: replaced with a plain `for` loop as part of the same refactor that extracted `nextHighlightedIndex` for #11's Menu tests — the allocation-free loop and the new pure function are the same code.

---

### 14. `fetchAllPages()` resolves only after accumulating every page
**Status: ⏭️ Recommended to close, not fixed**
**Severity: Low — partially mitigated already**
**Source**: `EFF-02`
**Location**: `frontend/src/api/client.js:105-119`

**Verification**: Confirmed that the function's returned promise only resolves once every page has been fetched. However, the code's own comment (lines 95-104) shows this was already partially addressed by a prior review cycle (`security-performance-review-2026-07-20.md` finding 4): an `onPage` callback now fires after each page with the cumulative array so far, letting callers render progressively instead of blocking on the full list. The remaining gap the 2026-07-25 finding correctly identifies is narrower than its own framing suggests: it's about the *final resolved promise* still requiring every page, not about the UI being blocked (that part is already fixed).

**Recommendation stands**: close as already-adequately-mitigated unless a concrete case shows up where the final-promise behavior itself (not the progressive rendering, which already works) causes a real problem.

---

### 15. Frontend image is baked to one enclave hostname
**Status: ⚪ Open — no action taken yet (fast-follow already scoped in `SHIPMENT_PLAN.md`, just not started)**
**Severity: Low — documented constraint, not a hidden defect, fast-follow already planned**
**Source**: `ENCLAVE-03`
**Location**: `scripts/build-release-images.sh:1-33`, `docs/plans/active/SHIPMENT_PLAN.md:97-99`

**Verification**: Confirmed that `VITE_API_URL`/`VITE_WS_URL` are build-time-baked (Vite inlines `import.meta.env.VITE_*`), and that this requires a per-enclave frontend rebuild on hostname change. `SHIPMENT_PLAN.md` Section 1.2 independently documents this as a deliberate v1.0 decision and already proposes the exact fast-follow fix the review recommends (a runtime-generated `/config.js`), explicitly scoped as "not a v1.0 blocker."

**Suggested next step**: the fast-follow design already exists in `SHIPMENT_PLAN.md` Section 1.2 — implementing it is a real, self-contained frontend/nginx feature (serve `/config.js` from the nginx container at startup, generated from a runtime env var), not urgent, and not something to sneak into a small batch given it touches the Docker/nginx build pipeline.

---

### 16. Known `--text-3` / dark active-row contrast debt
**Status: ⚫ Informational — pre-existing, no action planned**
**Severity: Informational — pre-existing, already tracked, not new**
**Source**: `A11Y-03`
**Location**: `README.md:37`, `frontend/src/global.css:54-57`

**Verification**: Confirmed present in `README.md`'s "Known issues" section verbatim, predating this review cycle. Correctly filed as informational rather than a new finding by the source review itself.

---

## Notes on cross-review corroboration

Four of the sixteen unique findings were independently rediscovered by two or three separately-scoped reviews examining the same code from different angles (confidentiality, availability/DoS, performance, maintainability, and audit/compliance). That convergence is itself signal: none of these four turned out to be a false positive on inspection, and multi-lens agreement is a reasonable proxy for "this is real and worth fixing first" even before line-by-line verification, which is why findings #1, #2, #6, and #7 anchor the top of their respective severity tiers — and, notably, all four are now the ones that have actually shipped.

## Recommended action order (updated)

1. ~~Fix the entity-summary authorization gap (#1)~~ — ✅ done, `v1.6.1`.
2. ~~Add abort/cancellation support to `acquireSlot()` (#2)~~ — ✅ done, `v1.6.2`.
3. ~~Fix menu `aria-activedescendant` (#3)~~ — ✅ done, `v1.6.3`, bundled with #10/#13 and Menu's half of #11.
4. Track #4/#5 against `SHIPMENT_PLAN.md`'s existing rehearsal plan rather than opening new work — they're accepted risks with owners already, not net-new defects, and need infra (a separate host, real GPU hardware) no code session can provide.
5. ~~Batch the remaining Low findings (#6-#15) as routine backlog/cleanup work~~ — #6/#7 done as one batch (`v1.7.0`); #12 and #14 confirmed as recommend-close, not fix. **Still open**: #8 (small, standalone), #9 (large, standalone, needs its own session), #11's Sheet half (needs its own extraction design), #15 (fast-follow scoped but not started).

**Suggested next single action**: #8 (reply-count query) — it's small, self-contained, and the fix is already fully specified by the source review. #9 (`ChatShell.jsx`) is the biggest remaining lump of value but should be its own dedicated session, not squeezed in alongside something else.
