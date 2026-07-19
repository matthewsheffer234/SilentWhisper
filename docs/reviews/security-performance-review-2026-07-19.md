# Silent Whisper Security And Performance Review — 2026-07-19

Scope: `PROJECT_PLAN.md`, `RUNBOOK.md`, and the current `/backend`, `/frontend`, `/database`, `/scripts`, and Compose code paths, reviewed against the explicit single-Node-instance, 100-concurrent-user invariants in `PROJECT_PLAN.md` Sections 2–3.

**Verified controls with no finding** (checked directly, not assumed): production password hashing uses async `bcrypt.hash`/`bcrypt.compare` exclusively, with a floor of 12 rounds (`config.auth.bcryptSaltRounds = Math.max(12, ...)`), never a sync variant, anywhere in the codebase; frontend access tokens live only in an in-memory module variable (`frontend/src/api/client.js`), never `localStorage`/`sessionStorage`; refresh cookies are `httpOnly`, `SameSite=Strict`, scoped to `/api/auth`, and `Secure` in production; refresh rotation row-locks the presented token and, on reuse, revokes every sibling token for that user; WebSocket connections start unauthenticated (no room joins, no data) until an `authenticate` frame validates, re-validate identity on every reconnect, and are swept for token expiry independently of REST; `audit_logs` appends serialize the read-latest-hash-then-insert step with `pg_advisory_xact_lock` on a fixed key, held for the whole transaction; the Postgres pool defaults to `min:2/max:20`, not 1:1 with user count; no PM2/cluster-mode deployment exists anywhere in the Compose files; all `db.raw()`/`knex.raw()` call sites use bound `?`/`??` parameters, never string-interpolated SQL; the membership-authorization module (`authz/membershipService.js`) is the single shared gate used by both REST and WebSocket, and correctly returns 404 (not 403) for non-members of a workspace/channel/org.

---

## High Impact

### 1. Unbounded AI task-extraction thread scan

**The Vulnerability/Defect**: `POST /api/messages/:messageId/ai/extract-tasks` validates channel membership, then loads *every* reply to the root message with no `LIMIT` or cursor before prompt construction:

```js
// backend/src/routes/ai.js:136-140
const replyRows = await db('messages as m')
  .join('users', 'users.id', 'm.user_id')
  .where('m.parent_message_id', root.id)
  .orderBy('m.created_at', 'asc')
  .select('users.username', 'm.content');
```

`LLM_MAX_INPUT_CHARS` truncation (`promptTemplates.js`) only runs *after* the full thread has already been read from Postgres and materialized into a JS array — unlike `GET /channels/:channelId/messages` and the summarize route's own `limit`-bounded query a few lines above it in the same file, which both cap the SQL read itself.

**The Exploit Scenario/Performance Vector**: Any authenticated channel member can grow a single thread to thousands of replies (nothing bounds thread length) and then repeatedly call task extraction on its root message. At 100 concurrent users, a handful of such threads force large ordered scans and large intermediate row-array allocations on every call, while also holding a DB connection and contending for `LLM_MAX_CONCURRENT_REQUESTS` (default 1) — the query cost scales with total thread history, not with the constant amount of data the LLM will actually see.

**Remediation**: Cap the thread source query in SQL, selecting the most recent N replies and restoring chronological order:

```js
const MAX_THREAD_AI_MESSAGES = 200;

const replyRows = await db
  .from(
    db('messages as m')
      .join('users', 'users.id', 'm.user_id')
      .where('m.parent_message_id', root.id)
      .orderBy('m.created_at', 'desc')
      .limit(MAX_THREAD_AI_MESSAGES - 1)
      .select('users.username', 'm.content', 'm.created_at')
      .as('limited_replies'),
  )
  .orderBy('created_at', 'asc')
  .select('username', 'content');
```

Add a cheap `count(*)` only if the audit payload needs an `omittedReplyCount`; never fetch every row just to learn the count.

### 2. Workspace digest's mention scan has no SQL-level cap

**The Vulnerability/Defect**: `selectMentionMessages()`, one of the two sources `POST /ai/workspace-digest` merges before capping, fetches *every* unread, non-dismissed mention in the requested window with no `LIMIT`:

```js
// backend/src/services/workspaceDigestService.js:26-47
async function selectMentionMessages(db, { userId, workspaceId, since }) {
  return db('mention_notifications as mn')
    .join(...)
    .where('mn.recipient_user_id', userId)
    .where('mn.workspace_id', workspaceId)
    .whereNull('mn.read_at')
    .whereNull('mn.dismissed_at')
    .where('mn.created_at', '>=', since)
    .orderBy('mn.created_at', 'asc')
    .select(...); // no .limit()
}
```

Its sibling `selectChannelMessages()` does bound its own query (`.limit(validChannelIds.length * DIGEST_MAX_MESSAGES_PER_CHANNEL)`), and `DIGEST_MAX_TOTAL_MESSAGES` (400) is applied only after both queries resolve, `Promise.all` completes, results are deduplicated into a `Map`, and the merged array is sorted — all proportional to the *pre-cap* row count, not the 400-row ceiling the design intends.

**The Exploit Scenario/Performance Vector**: `AI_DIGEST_MAX_WINDOW_HOURS` defaults to 336 (14 days) and the digest scope only requires the caller be a workspace member — a user who ignores mentions for two weeks in an active workspace (or is a target of mention spam — nothing caps how many messages can `@mention` the same user) can accumulate many thousands of matching rows. A single digest request then fully materializes and sorts all of them even though at most 400 are ever used, and `aiDigestRateLimiter` (5/10min per user) does not prevent this from happening at least once per window per user across many users concurrently.

**Remediation**: Push the cap into the SQL boundary, mirroring `selectChannelMessages()`'s own pattern:

```js
async function selectMentionMessages(db, { userId, workspaceId, since }) {
  return db
    .from(
      db('mention_notifications as mn')
        .join('messages as m', 'm.id', 'mn.message_id')
        .join('channels as c', 'c.id', 'mn.channel_id')
        .join('users as u', 'u.id', 'm.user_id')
        .join('channel_members as cm', function joinMembership() {
          this.on('cm.channel_id', '=', 'mn.channel_id').andOnVal('cm.user_id', '=', userId);
        })
        .where('mn.recipient_user_id', userId)
        .where('mn.workspace_id', workspaceId)
        .whereNull('mn.read_at')
        .whereNull('mn.dismissed_at')
        .where('mn.created_at', '>=', since)
        .orderBy('mn.created_at', 'desc')
        .limit(DIGEST_MAX_TOTAL_MESSAGES)
        .select('m.id as message_id', 'm.content', 'm.created_at', 'c.name as channel_name', 'u.username')
        .as('limited_mentions'),
    )
    .orderBy('created_at', 'asc')
    .select('*');
}
```

Keep `mentionCount` as a separate cheap `count(*)` for the audit payload rather than the full row count.

### 3. Audit-chain verification blocks the single event loop for the whole table

**The Vulnerability/Defect**: `POST /api/audit/verify` (system-admin only, no rate limit) calls `verifyAuditChain(db)`, which reads the *entire* `audit_logs` table in one unbounded query and then walks every row synchronously in a plain `for` loop, computing a SHA-256 hash per row with no `await`/yield point inside the loop body:

```js
// backend/src/audit/auditService.js:132-165
const rows = await db('audit_logs').orderBy('id', 'asc').select(/* all columns */); // no LIMIT
let expectedPrevHash = GENESIS_HASH;
for (const row of rows) {
  // ... crypto.createHash('sha256')... per row, no yield
}
```

This is architecturally different from the standalone `scripts/verify-audit-log.mjs` CLI tool the same function backs: that tool runs offline, outside the request-serving process. This route runs it **inside the single Node.js process that is also broadcasting every WebSocket message and serving every REST request** for all 100 concurrent users.

**The Exploit Scenario/Performance Vector**: `audit_logs` is append-only and grows from routine, frequent activity — every login/logout, every failed login, every AI summarize/extract-tasks/digest/semantic-search call, every membership change, every task-checkbox toggle, and every prior audit-dashboard page view (`AUDIT_DASHBOARD_ACCESSED` is itself audited) all write a row. As the table grows past low tens of thousands of rows, a single admin clicking "Verify Integrity" (or a scripted/automated integrity check hitting this endpoint) synchronously blocks the event loop for the full recomputation — during which every other user's WebSocket messages queue undelivered and every REST request stalls, a full-stack availability incident triggered by one authorized, well-formed admin action, not an attacker.

**Remediation**: Move the recomputation off the request-serving event loop, or make it incremental so it can yield:

```js
// Option A: batch with cooperative yielding (simplest, no new infra)
export async function verifyAuditChain(db, { batchSize = 5000 } = {}) {
  let expectedPrevHash = GENESIS_HASH;
  let lastId = 0;
  let rowsChecked = 0;
  for (;;) {
    const rows = await db('audit_logs')
      .where('id', '>', lastId)
      .orderBy('id', 'asc')
      .limit(batchSize)
      .select('id', 'actor_id', 'actor_ip', 'action_type', 'target_resource', 'payload', 'prev_row_hash', 'curr_row_hash');
    if (rows.length === 0) break;
    for (const row of rows) {
      // ... existing per-row check, returning early on failure as today ...
    }
    lastId = rows[rows.length - 1].id;
    rowsChecked += rows.length;
    await new Promise((resolve) => setImmediate(resolve)); // yield between batches
  }
  return { verified: true, rowsChecked };
}
```

For a stronger fix, run verification in a `worker_thread` (or a separate one-off process, like the CLI script already does) so a large table's cost never touches the request-serving thread at all.

---

## Medium

### 4. AI summarize/extract-tasks hold the sole concurrency slot for disconnected clients

**The Vulnerability/Defect**: `runStreamingCompletion()` (`backend/src/llm/aiService.js`) accepts an optional `signal` to abort the upstream LLM call early. Only `POST /ai/workspace-digest` wires this up:

```js
// backend/src/routes/ai.js:248-249, 259
const controller = new AbortController();
res.on('close', () => controller.abort());
...
result = await runStreamingCompletion({ ..., signal: controller.signal });
```

`POST /channels/:channelId/ai/summarize` and `POST /messages/:messageId/ai/extract-tasks` — the two AI features actually exercised on every "Summarize"/"Extract Tasks" click per `RUNBOOK.md` — call `runStreamingCompletion()` with no `signal` at all, so a client disconnect (tab closed, navigation away, network drop) has no effect on an in-flight request.

**The Exploit Scenario/Performance Vector**: `LLM_MAX_CONCURRENT_REQUESTS` defaults to 1, and `PROJECT_PLAN.md`/`config.js` both document this as deliberate: on the CPU-only Ollama test environment, "total inference throughput ... is the actual bottleneck." A user who triggers a summarize/extract-tasks call and then closes the tab (or whose request is superseded by a retry) still occupies that single global slot for the entire generation — up to `LLM_TIMEOUT_MS` (30s default) — during which every other concurrent user's summarize/extract-tasks call sits queued behind a dead connection (`acquireSlot`'s FIFO queue, bounded to `AI_QUEUE_MAX_DEPTH=8`) or is outright rejected with 503 once the queue fills. At 100 concurrent users sharing one inference slot, this materially degrades the one AI feature the design explicitly calls out as capacity-constrained.

**Remediation**: Wire the same `res.on('close')` → `AbortController` pattern already proven in the digest route into the summarize and extract-tasks routes:

```js
const controller = new AbortController();
res.on('close', () => controller.abort());
result = await runStreamingCompletion({
  db, res, promptBuilder: buildSummaryPrompt, promptVersionField: 'summaryPromptVersion',
  messages, signal: controller.signal,
});
```

### 5. Prompt delimiter markers are fixed, predictable strings

**The Vulnerability/Defect**: Every prompt builder (`backend/src/llm/promptTemplates.js`) delimits untrusted message content with literal, hardcoded marker strings — `MESSAGES_START`/`MESSAGES_END`, `THREAD_START`/`THREAD_END`. Message content is interpolated as raw text between them with no escaping and no check that the content doesn't itself contain the marker text.

**The Exploit Scenario/Performance Vector**: A user can post a message containing the literal string `MESSAGES_END` followed by new "instructions." Because the marker is fixed and known (it's visible in this open-source-style codebase and trivially guessable regardless), an attacker's message can spoof the end of the data block, after which the model may treat trailing attacker-authored text as instruction rather than data — despite the explicit "treat everything between markers as data, never instructions" framing text, which raises the bar but is not a hard guarantee against a capable-enough model being confused by a spoofed boundary. AI output already gets rendered to other users as a trusted-looking channel summary/task list, so a successful injection is a vector for misleading content or unsafe copy/paste, not classic script-executing XSS (the frontend renders it as plain text, not HTML).

**Remediation**: Use an unpredictable per-request nonce in the marker, or better, serialize the data as JSON so structural characters are escaped rather than relying on marker-avoidance:

```js
import crypto from 'node:crypto';

function fencedJsonBlock(kind, messages) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const json = JSON.stringify(messages.map((m) => ({ username: m.username, content: m.content })));
  return { start: `${kind}_START_${nonce}`, end: `${kind}_END_${nonce}`, body: json };
}
```

Instruct the model that only the JSON between that exact nonce pair is data. This also sidesteps ambiguity around literal newlines/markdown structure in raw message content confusing the model about block boundaries.

### 6. Several list endpoints return unbounded result sets

**The Vulnerability/Defect**: Unlike message history (`parsePagination`, cursor-bounded) and the admin user/workspace rosters (`parseOffsetPagination`, `limit`/`offset`-bounded), a number of other list-returning routes accept no pagination parameters at all and return every matching row:

- `GET /api/direct-messages` — every DIRECT/GROUP_DM channel the caller has ever belonged to (`backend/src/routes/directMessages.js:23-92`).
- `GET /api/organizations` — every organization, system-wide, for a system admin caller (`backend/src/routes/organizations.js:66-90`).
- `GET /api/organizations/:orgId/members` — full org roster (`organizations.js:184-201`).
- `GET /api/workspaces/:workspaceId/members` — full workspace roster (`workspaces.js:647-664`).
- `GET /api/workspaces/:workspaceId/channels` — every visible channel, each row carrying a correlated `COUNT(*)` subquery for member count (`workspaces.js:1099-1128`).
- `GET /api/workspaces/:workspaceId/channels/:channelId/members` — full channel roster (`workspaces.js:1170-1189`).

`markAllMentionNotificationsRead()` compounds this pattern at the service layer: it `SELECT`s every visible unread notification id into a JS array, then issues a second `UPDATE ... WHERE id IN (...)` built from that array (`backend/src/services/mentionNotificationService.js:158-173`), rather than a single set-based update.

**The Exploit Scenario/Performance Vector**: The 100-user target bounds *concurrent users*, not the size of the objects those users accumulate over the application's lifetime — a long-lived deployment can easily grow thousands of DMs per active user, tens of workspaces/channels, and large notification backlogs from mention spam (nothing rate-limits how many times one user can be `@mentioned`). Each of these routes' cost scales with that historical total, not with anything bounded, and several are called on ordinary page loads (workspace sidebar, channel list) rather than admin-only actions — so under concurrent normal use, not just abuse, the backend can end up materializing large arrays and, for the notification case, building a large `WHERE IN (...)` clause, on the same single Node process serving everyone else.

**Remediation**: Extend `parseOffsetPagination`/`parsePagination` to every route above, following the precedent `GET /admin/users` and `GET /workspaces/admin/all` already set. For `markAllMentionNotificationsRead`, do the update in one set-based statement instead of select-then-update:

```js
export async function markAllMentionNotificationsRead(db, userId) {
  const rows = await db('mention_notifications')
    .where({ recipient_user_id: userId })
    .whereNull('read_at')
    .whereNull('dismissed_at')
    .whereExists(function visibleChannel() {
      this.select(1)
        .from('channel_members as cm')
        .whereRaw('cm.channel_id = mention_notifications.channel_id')
        .andWhere('cm.user_id', userId);
    })
    .update({ read_at: db.fn.now() })
    .returning('id');
  return { updated: rows.length };
}
```

For the channel-list correlated subquery, replace it with a pre-aggregated join (`GROUP BY channel_id` joined once) and still paginate the outer channel rows.

### 7. Workspace member-search leaks email addresses to any plain member

**The Vulnerability/Defect**: `GET /api/workspaces/:workspaceId/members-search` is gated only on plain `requireWorkspaceMember` (any member, no admin permission needed) and returns every matching member's email address:

```js
// backend/src/routes/workspaces.js:734-792
await requireWorkspaceMember(db, req.user.id, workspaceId);
...
const selectCols = ['users.id', 'users.username', 'users.display_name', 'users.email'];
...
res.json(rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, email: r.email, ... })));
```

This directly contradicts the route's own design comment immediately above it, which justifies the deliberately-loose (plain-member) gate by name-checking exactly which fields are safe to expose: *"every field returned here (id/username/displayName) is already visible to any workspace-mate through message authorship and mentions, so this isn't a new disclosure"* — a list that conspicuously does not include `email`, because email is **not** visible through message authorship or mentions anywhere else in the app. The parallel, more-tightly-scoped endpoint one file over, `GET /api/organizations/:orgId/members-search` (`organizations.js:263-297`), implements the stated design correctly and omits email entirely. The frontend confirms this is a real, rendered disclosure, not dead data: `PeoplePicker.jsx:322` renders `person.email` directly wherever a picker built on this endpoint (private-channel "add people," ownership transfer) is shown.

**The Exploit Scenario/Performance Vector**: Any authenticated MEMBER of a workspace — no MANAGE_MEMBERS or admin privilege required — can page through `members-search` (with an empty or single-character `q`) and harvest every other workspace member's email address, something the codebase's own reasoning explicitly says should require the tighter `people-search` gate (`WORKSPACE_MANAGE_MEMBERS`) precisely because "this reveals matching accounts by email." This is a straightforward least-privilege violation and PII exposure to a broader audience than intended, even though the app is intranet-hosted.

**Remediation**: Drop `email` from `members-search`'s select/response, matching its own stated justification and its org-scoped sibling:

```js
const selectCols = ['users.id', 'users.username', 'users.display_name'];
if (channelId) selectCols.push('cm.user_id as channelMemberUserId');
const rows = await query.orderBy('users.username', 'asc').limit(limit).select(selectCols);

res.json(rows.map((r) => ({
  userId: r.id,
  username: r.username,
  displayName: r.display_name,
  isSelf: r.id === req.user.id,
  ...(channelId ? { alreadyInChannel: r.channelMemberUserId != null } : {}),
})));
```

Update `PeoplePicker.jsx:322` to fall back to something other than `person.email` (e.g. username) when rendering results from this endpoint specifically.

### 8. Refresh endpoint issues a fresh access token without rechecking account status

**The Vulnerability/Defect**: Login and WebSocket re-authentication both re-check `users.status === 'ACTIVE'` before issuing/renewing a session. `POST /api/auth/refresh` does not:

```js
// backend/src/routes/auth.js:189-208
const { userId, newRawToken } = await rotateRefreshToken(db, rawToken);
const user = await db('users').where({ id: userId }).first(); // no status filter
const accessToken = signAccessToken({ userId, username: user.username, displayName: user.display_name });
setRefreshCookie(res, newRawToken);
...
res.json({ accessToken });
```

The admin-disable path (`admin.js` `/users/:userId/disable`) does proactively call `revokeAllRefreshTokensForUser`, so this gap is normally covered — but the refresh endpoint itself doesn't independently enforce the invariant, which every other credential-issuing path in the app does.

**The Exploit Scenario/Performance Vector**: Any code path that changes `users.status` to `DISABLED` without also revoking refresh tokens (a future admin feature, a direct DB update during an incident response, a bug in a new call site) leaves a still-valid, unrevoked refresh token able to mint a fresh 15-minute access token for a disabled account indefinitely — `requireAuth`'s own status check catches the *resulting* access token on the next REST call, but only after `/refresh` has already rotated session state and logged a routine-looking `AUTH_TOKEN_REFRESH` audit event that gives no indication anything was wrong. This is a defense-in-depth gap in an otherwise consistently-enforced invariant (every other entry point rechecks status), not a currently-reachable bypass given today's single disable code path.

**Remediation**: Recheck status after rotation and revoke on failure, symmetric with login's handling:

```js
const { userId, newRawToken } = await rotateRefreshToken(db, rawToken);
const user = await db('users').where({ id: userId, status: 'ACTIVE' }).first();
if (!user) {
  await revokeAllRefreshTokensForUser(db, userId);
  clearRefreshCookie(res);
  throw new UnauthorizedError('Invalid refresh token');
}
```

Add a regression test: disable a user while a live refresh token exists, confirm `/api/auth/refresh` 401s, clears the cookie, and issues no access token.

---

## Low / Logical Discrepancies

### 9. Direct-message creation has no protection against a concurrent-duplicate race

**The Vulnerability/Defect**: `POST /api/direct-messages` looks up an existing 1:1 DIRECT channel and creates one if none exists, inside a single `db.transaction()`:

```js
// backend/src/routes/directMessages.js:130-143
const result = await db.transaction(async (trx) => {
  const existingId = await findExistingDirectChannel(trx, req.user.id, targetUserId);
  if (existingId) return { id: existingId, created: false };
  const [channel] = await trx('channels').insert({ workspace_id: null, name: 'Direct Message', type: 'DIRECT' }).returning(['id']);
  await trx('channel_members').insert([...]);
  return { id: channel.id, created: true };
});
```

Postgres's default `READ COMMITTED` isolation does not prevent two concurrent transactions from both running `findExistingDirectChannel` before either commits its `INSERT` — both can observe "no existing channel" and both proceed to create one. Nothing in the schema enforces uniqueness here: `database/migrations/0003_layout_and_hierarchy.js` has no unique index over the (channel-type, member-set) shape that would let the database itself reject the second insert, and the transaction takes no row lock (`SELECT ... FOR UPDATE`) or advisory lock to serialize concurrent callers the way `rotateRefreshToken`/`invitations.js`'s accept route already do for their own race-prone paths.

**The Exploit Scenario/Performance Vector**: Two people clicking "Message" on each other within the same request window (a very plausible UI interaction — e.g. both open each other's profile from a shared roster at the same moment), or a client retry after a slow response, can each independently pass the "no existing channel" check and create two separate DIRECT channels between the same pair. The endpoint's own documented purpose — "creates or reuses a 1:1 DIRECT channel" — silently fails under exactly the concurrency level this app targets (100 simultaneous users), fragmenting the pair's conversation across two channels with no user-visible indication of why.

**Remediation**: Serialize the check-then-insert with an advisory lock keyed on the sorted pair of user ids (cheap, avoids taking a table-wide lock), mirroring the pattern `auditService.js` already establishes for its own race:

```js
async function findOrCreateDirectChannel(trx, userA, userB) {
  const [lo, hi] = [userA, userB].sort();
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`dm:${lo}:${hi}`]);
  const existingId = await findExistingDirectChannel(trx, userA, userB);
  if (existingId) return { id: existingId, created: false };
  const [channel] = await trx('channels').insert({ workspace_id: null, name: 'Direct Message', type: 'DIRECT' }).returning(['id']);
  await trx('channel_members').insert([{ channel_id: channel.id, user_id: userA }, { channel_id: channel.id, user_id: userB }]);
  return { id: channel.id, created: true };
}
```

A longer-term fix is a partial unique index if the DM shape is ever normalized into its own table, but the advisory lock is the minimal, schema-preserving fix consistent with this codebase's existing conventions.

---

## Summary Table

| # | Finding | Category | Severity |
|---|---|---|---|
| 1 | Unbounded thread scan in AI task extraction | Performance / boundary clamping | High |
| 2 | Unbounded mention scan in workspace digest | Performance / boundary clamping | High |
| 3 | `POST /audit/verify` blocks the event loop over the full table | Performance / concurrency | High |
| 4 | Summarize/extract-tasks don't cancel on client disconnect, starving the sole AI slot | Performance / concurrency | Medium |
| 5 | Prompt delimiters are fixed, guessable strings | Security / LLM injection | Medium |
| 6 | Several roster/list endpoints have no pagination | Performance / boundary clamping | Medium |
| 7 | `members-search` leaks member email to any plain workspace member | Security / authorization, PII | Medium |
| 8 | `/auth/refresh` doesn't recheck account status post-rotation | Security / session lifecycle | Medium |
| 9 | DM creation races can create duplicate DIRECT channels | Logical discrepancy / concurrency | Low |
