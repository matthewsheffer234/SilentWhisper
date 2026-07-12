# Feature Requests — Running Plan

A living backlog of feature ideas for Silent Whisper. This is a planning document, not an implementation log — see `PROJECT_PLAN.md` Section 11 for what's actually been built.

## How this document is maintained

- Whenever a new feature is requested, a design is thought through (what changes, where, how it fits the existing authorization/audit/rate-limiting conventions in `PROJECT_PLAN.md`) and added below as its own entry, in the format under "Entry format."
- After each addition, every entry is re-ranked by utility — most useful first. Rank changes are expected over time as the app's shape changes; nothing here is permanent.
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

### 1. Semantic message & channel search via pgvector

**Status**: Proposed
**Utility**: High. This directly improves the value of a long-lived project workspace: a researcher or new team member can recover historical context from thousands of archived messages by asking conceptual questions instead of guessing the exact words people used years earlier.
**Origin**: Requested directly as part of "Advanced Silent Whisper AI Enhancements," with explicit pgvector, local embedding-model, ingestion-pipeline, and semantic-search endpoint constraints.

Design:
- **Database/vector storage**: enable the `vector` extension in the PostgreSQL container via a new migration (`CREATE EXTENSION IF NOT EXISTS vector`) alongside the existing `uuid-ossp` extension pattern. Add a message embedding table rather than widening `messages` directly, e.g. `message_embeddings(message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, embedding vector(N) NOT NULL, model VARCHAR(100) NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`. `N` must match the configured embedding model dimension (for `all-minilm`-class models, commonly 384) and should be documented in the migration/config so model swaps are deliberate.
- **Indexing**: add an approximate vector index appropriate for cosine search (`hnsw` or `ivfflat` with `vector_cosine_ops`, selected based on the installed pgvector version). Keep the existing membership/channel indexes as the authorization fast path; vector search must still filter by channels the caller can read before results are returned.
- **Embedding provider**: extend the existing local AI-provider boundary instead of calling an external API. Add an embedding method that asynchronously posts to the configured local LLM proxy (Ollama/vLLM) using a lightweight embedding model such as `all-minilm`; configure model name, dimension, timeout, and concurrency separately from generation settings so summarization latency and embedding backlog do not starve each other.
- **Ingestion pipeline**: when a message is committed through either REST or WebSocket, enqueue embedding work after the DB commit succeeds. This must be asynchronous and failure-tolerant: message send success cannot depend on the embedding provider being up. Failed embedding jobs should be retryable and observable through logs/metrics; at this scale, a lightweight DB-backed queue table is acceptable before introducing a separate worker system.
- **Search API**: add a dedicated semantic search endpoint, e.g. `POST /api/search/semantic` with `{ workspaceId?, channelId?, query, limit? }`. The backend vectorizes the query with the same configured embedding provider and ranks results by cosine similarity. Results include message id, channel/workspace metadata the caller is allowed to see, a short content excerpt, timestamp, author display fields, and similarity score.
- **Authorization**: apply the same existence-hiding convention as message history. A user may only search channels they are a member of, including private channels, direct messages, and group DMs; no search result should reveal that a hidden channel or message exists. Optional `workspaceId`/`channelId` filters must be validated through the existing membership helpers before vector lookup.
- **UI**: add a semantic search surface separate from exact text search if exact search is added later. The input should invite conceptual queries, but results must be presented as message/channel hits with clear timestamps and navigation into the original thread/channel context.
- **Audit/rate limiting**: rate-limit semantic search per user, since each query triggers embedding work and a vector scan. Audit only if this is treated as an AI operation under the existing AI audit conventions; if audited, log prompt/query length, model name, and result count, not full query text unless the project explicitly decides search queries are non-sensitive.
- **Tests**: migration enables pgvector and creates the embedding table/index; ingestion queues embedding work from both REST and WS message paths; provider failures do not fail message creation; search filters out channels the caller cannot read; results sort by cosine similarity; malformed filters return the same 404/400 pattern used by existing channel/message endpoints.

### 2. Cross-channel "Catch Me Up" workspace digests

**Status**: Proposed
**Utility**: High. This is a natural next step for the existing local AI features: it turns unread mentions and important channel activity into a short operational brief for someone returning from a multi-day break, instead of forcing them to manually scan every backlog thread.
**Origin**: Requested directly as part of "Advanced Silent Whisper AI Enhancements," with an explicit `POST /api/ai/workspace-digest` endpoint, variable time window, context-window batching, and SSE/WebSocket streaming constraints.

Design:
- **API**: add `POST /api/ai/workspace-digest`, behind `requireAuth`, with a body such as `{ workspaceId, sinceHours?, sinceDays?, starredChannelIds?, includeMentionsOnly? }`. Clamp the requested window to a configured maximum so a single request cannot pull years of message history into an LLM job.
- **Source selection**: query unread messages that mention the user plus unread threads/messages in the user's starred channels within the requested time window. If starred channels do not exist yet, this feature either depends on adding a small `starred_channels(user_id, channel_id, created_at)` table first or starts with an explicit channel list and leaves first-class starring as a prerequisite companion feature.
- **Authorization**: every selected message must come from a channel the caller can currently read. Private channels, DMs, and group DMs follow the same membership checks as message history and AI summarize/extract endpoints; no digest can leak messages from channels the caller cannot access.
- **Unread model**: this feature needs a durable read-state source if one is not already present. Add or depend on per-user/channel read markers (`last_read_message_id` or `last_read_at`) so "unread" is not guessed from timestamps alone. Direct mentions can be detected either from the future mention feature's persisted data if it exists, or by a bounded username-token query over recent messages as a v1 fallback.
- **Prompt batching**: batch and slice message text to fit the configured local model's context window (`mistral`, vLLM-hosted models, etc.). Preserve enough metadata in each chunk (channel, thread root, author, timestamp) for the final summary to cite where action items came from. Summaries should be hierarchical: per-batch summaries first, then a final merge pass for a unified digest.
- **Streaming**: stream markdown back to the client using SSE or WebSockets. SSE is likely the simplest REST-shaped fit (`text/event-stream`) unless the existing WebSocket client already has a robust request/response pattern for AI streams. The UI should render partial markdown as it arrives and allow cancellation without leaving the provider request running indefinitely.
- **Output shape**: generate a concise markdown digest with sections for urgent mentions, action items assigned to or involving the user, unresolved questions, decisions made while away, and links/back-references to the originating channel/thread where possible. Treat all model output as untrusted text when rendering, consistent with the existing AI output rules.
- **Rate limiting/concurrency**: enforce the same global `LLM_MAX_CONCURRENT_REQUESTS` style cap used by channel summaries, plus a stricter per-user digest rate limit because this endpoint can scan many channels and run multiple prompt batches.
- **Audit**: audit as an AI operation with workspace id, requested window, selected message count, chunk count, provider/model, prompt version, and truncated input length. Do not log raw message content in the audit payload.
- **Tests**: endpoint selects only authorized unread mentions/starred-channel messages; time-window clamping works; long inputs are chunked below configured limits; provider streams are forwarded incrementally to the client; cancellation closes the upstream provider request; audit rows record metadata without raw content.

### 3. Self-service workspace subscription (discover + join)

**Status**: Proposed
**Utility**: Medium. The just-built invite endpoint (`POST /workspaces/:workspaceId/members`) covers "an admin adds a specific known person," but there's still no way for a user to find and join a workspace on their own — every workspace is effectively invite-only forever, with no equivalent of a `PUBLIC` channel's self-join. Matters more as the number of workspaces/users grows past a handful of admin-curated invites; less urgent than the two entries above at the app's current scale.
**Origin**: Requested directly. Interpreted as **self-service join for openly-discoverable workspaces**, mirroring how `PUBLIC` channels already work — flagging this interpretation explicitly in case "subscribe" was meant as a notification/digest feature (e.g. "notify me of activity in this workspace without being a full member") instead, which would be a materially different, smaller design (no new membership row, just a `workspace_subscriptions` notification-preferences table) and isn't what's designed below.

Design:
- **Schema**: add `visibility VARCHAR(20) NOT NULL DEFAULT 'PRIVATE'` to `workspaces` (new migration — `0008` is already taken by the shipped workspace-archiving migration, so this is `0009_workspace_visibility.js`), enum `PUBLIC`/`PRIVATE` — same values and spirit as `channels.type`'s `PUBLIC`/`PRIVATE`. Defaulting existing (and newly created, unless specified) workspaces to `PRIVATE` preserves today's actual behavior — nothing becomes discoverable by accident.
- **`POST /workspaces`** (existing endpoint) gains an optional `visibility` field in the request body, validated against a new `WORKSPACE_VISIBILITY = ['PUBLIC', 'PRIVATE']` enum (`validation.js`, alongside the existing `CREATABLE_CHANNEL_TYPES`), defaulting to `PRIVATE` if omitted.
- **`GET /workspaces/discoverable`** — lists `PUBLIC`-visibility workspaces the caller is *not* already a member of (so the browse list and the "your workspaces" list never overlap), same shape as the existing `GET /workspaces` response minus `role` (the caller has none yet).
- **`POST /workspaces/:workspaceId/subscribe`** — self-service join, authorized only by `visibility = 'PUBLIC'` (401/403 aren't right here; a `PRIVATE` workspace should 404 exactly like any other not-a-member case, per Section 3's existence-hiding convention — don't let this endpoint become a way to confirm a private workspace's existence). Inserts `workspace_members` with `system_role = 'MEMBER'`, exactly mirroring `channels/:id/join`'s "Only public channels can be self-joined" pattern and its `ValidationError` (400) when the target isn't `PUBLIC`. Must also call the now-shipped `requireWorkspaceNotArchived` (`authz/membershipService.js`, from the workspace archive/unarchive feature) — an archived workspace shouldn't be self-joinable even if it was left `PUBLIC`.
- Audited as `WORKSPACE_MEMBERSHIP_CHANGE` (the same action type the invite endpoint already uses) with `payload: { action: 'subscribe' }`, distinguishing it from `action: 'add'` (admin-invited) in the same audit trail without a new action type.
- **Frontend**: a "Browse workspaces" view (own modal, matching the `AiSettingsPanel`/`AuditDashboard` pattern already established) listing `GET /workspaces/discoverable` results with a "Subscribe" button per row; the existing `+ New workspace` form gains a visibility toggle (default Private, matching the schema default).
- **Explicitly out of scope for this entry, but worth flagging as a natural companion**: a symmetric self-service **leave workspace** (unsubscribe) — without it, self-joining is a one-way door, which is an odd asymmetry for a self-service feature. Not designed here since it wasn't requested, but if this ships, revisit whether it should ship alongside it rather than as a separate later ask.
- Tests: subscribing to a `PUBLIC` workspace succeeds and is idempotent-safe (already-a-member → no duplicate row, matching the join-endpoint precedent); subscribing to a `PRIVATE` workspace (by a caller who isn't already a member — e.g. guessed or previously-seen id) 404s, not 400, per the existence-hiding note above; `GET /workspaces/discoverable` never includes a `PRIVATE` workspace or one the caller already belongs to; audit row present with the right `action` discriminator.

### 4. @mention autocomplete in the message composer

**Status**: Proposed
**Utility**: Medium. A direct usability follow-on to the already-shipped mention feature (`FEATURE_REQUEST.md`'s Done section, `backend/src/services/mentionService.js`): today typing `@someone` is a blind guess with no feedback — a typo, a wrong capitalization pattern that happens to still match `USERNAME_RE`, or mentioning a real user who just isn't a member of *this* channel all silently resolve to zero notifications, by design (existence-hiding), with nothing in the UI telling the sender their mention didn't land. Lower urgency than the auth/admin gaps ranked above it (nothing is blocked without this — a mention can still be typed by hand), but a real, concrete rough edge on the app's single highest-ranked shipped feature.
**Origin**: Requested directly, as a follow-on to the shipped mentions feature.

Design:
- **New endpoint — `GET /channels/:channelId/members?q=<prefix>&limit=<n>`** (`backend/src/routes/messages.js`, a sibling to the existing `GET /channels/:channelId/messages` — same URL family, same file already imports `requireChannelMember`, rather than introducing a new nested `/workspaces/:workspaceId/channels/:channelId/members` shape that doesn't match how channel-scoped reads are already addressed in this app). No such "who is in this channel" endpoint exists anywhere today — confirmed by grep, every existing `channel_members`/`workspace_members` touch point is a `POST` (invite, join, add-to-channel) or an internal-only check (`authz/membershipService.js`).
  - `assertUuid(channelId)` → `requireChannelMember(db, req.user.id, channelId)` — same existence-hiding gate as message history (404 for a non-member or a nonexistent channel, indistinguishable), directly required by Section 3: "Private channels, direct messages, and group DMs must never be joinable, listable, or readable by non-members, **including via search**."
  - `q` is optional (empty/omitted returns the first page of members alphabetically — the expected combobox behavior right after typing a bare `@`) and bounded to `MAX_USERNAME_LENGTH` (50 chars, `validation.js`) if present; matched via `username ILIKE ?||'%'` (prefix, case-insensitive) against `channel_members ⋈ users` scoped to `channel_id = ?`.
  - **Excludes the caller from results** — mirrors `mentionService.js`'s `excludeUserId` exactly (self-mentions never notify, so suggesting yourself just wastes a dropdown row); typing your own username by hand still works identically to today, it's just never suggested.
  - **Capped at a small `limit`** (default/max e.g. 8, same resource-bound instinct as `MAX_MENTIONS_PER_MESSAGE`/`parsePagination`'s `MAX_PAGE_LIMIT`) — a dropdown needs a handful of candidates, not an exhaustive channel roster.
  - Response: a lean `[{ id, username }]` array — no email or other fields, since the composer only ever needs to render and insert a username.
  - **Not audited** — same reasoning `mentionService.js` already gives for not auditing mention resolution itself: this is a read of membership data already visible to the caller by virtue of being a member of the same channel, not a new security-relevant action.
- **Rate limiting — new per-user limiter**, not per-IP (`backend/src/auth/rateLimit.js`, copying `llm/aiRateLimit.js`'s `aiProxyRateLimiter` shape exactly: `keyGenerator: (req) => \`member-search:${req.user.id}\``, `skip: skipInTest`, same JSON 429 handler) — a real gap otherwise, since this is the first endpoint in the app designed to be hit on every keystroke rather than once per user action. `PROJECT_PLAN.md` Section 3 doesn't name autocomplete/typeahead explicitly, but its AI-proxy rate-limiting rationale ("an unbounded loop from a buggy or malicious client could starve...") applies by direct analogy to a cheap-but-frequent DB query too. A much higher ceiling than `aiProxyRateLimiter`'s 10-per-5-minutes is appropriate given the cost difference — e.g. 60/minute — paired with client-side debouncing (below) so the ceiling is a backstop against a buggy/malicious client, not something normal typing speed would ever brush against.
- **Frontend — `frontend/src/api/workspaces.js`**: new `searchChannelMembers(channelId, query)`, following `listMessages`'s existing conditional-`URLSearchParams` pattern exactly.
- **Composer** (`frontend/src/components/ChannelView.jsx`): the composer is a plain `<input type="text">` (not contenteditable), so `e.target.selectionStart` is directly available on every `onChange` — add a `composerRef` and track caret position there. Trigger detection scans backward from the caret for an in-progress `@token` not preceded by a word character (distinct from the existing rendering-side `MENTION_RE`, which requires the 3-char minimum already satisfied and isn't caret-anchored — this needs to match a partial token while the user is still mid-word, e.g. `@ma`).
  - Debounce (~200ms) before calling `searchChannelMembers`, both for its own sake and as the client-side half of the rate-limiting story above.
  - Render suggestions in a small dropdown anchored under the composer. Follows the standard combobox pattern rather than a custom widget (per Section 7's "use standard, recognizable controls... rather than custom gestures or nonstandard widgets"): DOM focus never leaves the `<input>`, the highlighted suggestion is tracked in local state and exposed via `aria-activedescendant`, the dropdown itself is `role="listbox"` with `role="option"` rows.
  - Keyboard handling on the composer's existing `onKeyDown`: ArrowUp/ArrowDown move the highlighted suggestion; Enter/Tab accepts it (replaces the in-progress `@token` in `draft` with the full `@username ` and advances the caret past it) **and must not also submit the form** — the existing `handleSubmit` fires on the form's `onSubmit`, so Enter while the dropdown is open needs to be intercepted (`e.preventDefault()`) before it reaches that handler; Escape dismisses the dropdown without altering `draft` or submitting.
  - Mouse-click selection on a suggestion row also accepts it; dismiss-on-blur needs the standard combobox delay (a bare `blur` fires before a `mousedown`-driven row click registers, so the dropdown can't close synchronously on blur or the click never lands).
  - No transition/animation on open/close — matches `ChatShell.jsx`'s mention toast (also unanimated), sidesteps needing a separate `prefers-reduced-motion` branch for this one surface.
- **Not in scope for this entry**: `@everyone`/`@channel`-style broadcast mentions (a materially different, higher-blast-radius feature — notifying an entire channel's membership at once — not something an autocomplete-polish entry should grow into unilaterally); `#channel`-name autocomplete (a separate, symmetric feature with its own trigger character, if ever wanted).
- **Tests**:
  - Backend: a non-member (or nonexistent channel) gets 404; prefix matching is case-insensitive and resolves partial usernames; results are capped at the configured limit; the caller is excluded from their own results; a malformed `channelId` 400s; exceeding the rate limit 429s (mirroring `messages.test.js`'s existing rate-limit test pattern).
  - Frontend/e2e: typing `@` followed by a partial username shows a dropdown of matching channel members; Enter and a mouse click both insert the full `@username ` and close the dropdown; Escape dismisses without altering the draft or submitting the message; a non-matching partial shows no suggestions without erroring.

## Done

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
