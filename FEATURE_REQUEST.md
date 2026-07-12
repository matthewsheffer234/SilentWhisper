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

### 1. Self-service password change

**Status**: Proposed
**Utility**: High. There is currently no way for any user to change their own password without direct database access — every account is one bcrypt hash away from being permanently locked out of self-service recovery. This is a real, standing gap in a core auth flow, not a nice-to-have.
**Origin**: Surfaced when asked to change the `admin` account's password — done via a direct database update (bcrypt hash write + manual refresh-token revocation) because no endpoint exists.

Design:
- **`POST /api/auth/change-password`** (`backend/src/routes/auth.js`), behind `requireAuth`.
  - Body: `{ currentPassword, newPassword }`.
  - Verify `currentPassword` against the caller's own `password_hash` via `bcrypt.compare` (async) — a 401 (`UnauthorizedError`) on mismatch, not 400, since this is a credential check like login, not a validation failure.
  - Validate `newPassword` with the existing `assertValidPassword` (`auth/passwordPolicy.js`) — same 10-char-minimum/common-password-deny-list policy as signup, no separate rules.
  - Hash the new password with `bcrypt.hash` at `config.auth.bcryptSaltRounds` (same as signup/login), update `users.password_hash`.
  - **Revoke every other outstanding refresh token for that user** (`refresh_tokens` `WHERE user_id = ? AND revoked_at IS NULL`), matching the reuse-detection precedent in `auth/refreshTokens.js` (a password change is exactly the kind of event that should force re-authentication everywhere else). The *current* session should not be logged out by its own password change, though — issue a fresh access token + rotate a fresh refresh token in the response (same shape as `/login`), rather than revoking indiscriminately including the request's own session.
  - Audit as a new `AUTH_PASSWORD_CHANGE` event (actor = the user themselves, no payload beyond that — never log password material, hashed or not).
  - Tests: wrong `currentPassword` → 401; `newPassword` failing policy → 400; success → 200 with new working tokens, old sessions' refresh tokens rejected, audit row present.
- **Frontend**: a small form (own component or folded into a settings-style modal, matching the `AiSettingsPanel`/`AuditDashboard` pattern) reachable from a "Change Password" control near "Sign out" in `WorkspaceSidebar`. Current password + new password fields, inline error on wrong current password or policy rejection, success feedback, no page reload needed (swap in the new access token from the response the same way login does).
- Not in scope for this feature: password reset for a user who's forgotten their password and can't authenticate at all (that's a separate "forgot password" flow requiring email delivery, which this offline-first app doesn't have infrastructure for yet — a distinct, larger feature if ever needed).

### 2. Workspace archive / unarchive

**Status**: Proposed
**Utility**: High. Workspaces are explicitly project-scoped (Section 6: "Users can create project-based workspaces") — projects end, and right now a finished workspace has no lifecycle state besides "still fully active forever." Without this, the workspace list only grows, dead projects stay just as writable as live ones, and there's no way to signal "this is done" short of deleting data outright (which the app has no path for either, and shouldn't for an audit-logged system).
**Origin**: Requested directly.

Design:
- **Schema** (new migration, `database/migrations/0008_workspace_archiving.js`): add `archived_at TIMESTAMP WITH TIME ZONE NULL` and `archived_by UUID REFERENCES users(id) NULL` to `workspaces`. A nullable timestamp (not a boolean) matches the existing `refresh_tokens.revoked_at` convention elsewhere in the schema and records *when*, not just *whether*. Both default `NULL` — every existing workspace stays active, no backfill needed.
- **`POST /workspaces/:workspaceId/archive`** — authorized if the caller is the workspace's `owner_id` **or** holds `system_role = 'ADMIN'` in `workspace_members`, per the request ("owners and admins"). Since `requireWorkspaceAdmin` (`authz/membershipService.js`) only checks the membership role, this needs a small new helper — e.g. `requireWorkspaceOwnerOrAdmin(db, userId, workspaceId)` — checking `workspaces.owner_id === userId` first (cheap, no extra query beyond the workspace row already fetched) before falling back to `getWorkspaceRole`. Sets `archived_at = now()`, `archived_by = caller`. No-ops (200, not an error) if already archived, matching the existing idempotent-join-style handling elsewhere (`channels/:id/join`, the new `/members` invite).
- **`POST /workspaces/:workspaceId/unarchive`** — authorized by `requireWorkspaceAdmin` only (`system_role = 'ADMIN'`), deliberately narrower than archive's owner-or-admin gate, matching the request's explicit distinction ("admins should also be able to un-archive"). Clears `archived_at`/`archived_by`.
- **Enforcing "cannot be updated"**: every *write* path that touches a workspace or one of its channels needs a shared `requireWorkspaceNotArchived(db, workspaceId)` check (Section 3's "centralize... so the rule is written once and cannot drift" applies here exactly as it did for membership checks) — read paths (`GET /workspaces`, `GET .../channels`, message history, AI summarize) stay allowed, since archiving means read-only, not hidden or frozen from view. Gate list:
  - `POST /workspaces/:workspaceId/members` (invite)
  - `POST /workspaces/:workspaceId/channels` (create channel)
  - `POST /workspaces/:workspaceId/channels/:channelId/join`
  - `POST /workspaces/:workspaceId/channels/:channelId/members`
  - `POST /channels/:channelId/messages` (REST) — needs a `channels.workspace_id` lookup first, since this route is keyed by channel not workspace
  - `ws/server.js`'s `handleMessage` — the same check, so the WS send path can't bypass what the REST path blocks (same anti-drift principle Phase 3 already established for membership checks)
  - Returns 409 (`ConflictError`) with a clear message ("This workspace is archived") — not 403, since the caller isn't unauthorized, the *action* is unavailable given the resource's current state.
- **Listed separately**: `GET /workspaces` already returns each workspace's `role`; add `archivedAt` (nullable) to that same response rather than a second endpoint or a filter param — the frontend splits the existing single list into "Workspaces" / "Archived" sections in `WorkspaceSidebar` based on that field, the same way `channels[].isMember` already drives conditional rendering there.
- **Frontend**: an "Archive workspace" control (owner/admin-gated, mirroring the new "+ Invite member" visibility pattern) plus an "Unarchive" control shown only inside the Archived section (admin-gated). Archived workspaces render read-only — hide "+ New channel," "+ Invite member," and the message composer (`ChannelView` already has a `joined`-gated disabled composer state to extend, rather than a new one).
- Audited as `WORKSPACE_ARCHIVE_STATUS_CHANGE` with `payload: { action: 'archive' | 'unarchive' }` — one action type with a payload discriminator, matching the existing `CHANNEL_MEMBERSHIP_CHANGE`/`WORKSPACE_MEMBERSHIP_CHANGE` convention rather than inventing two new action-type constants for one state transition.
- Tests: owner can archive, admin can archive, a plain member cannot (403); only an admin can unarchive, not a non-admin owner-who-somehow-isn't-admin (403); every gated write path 409s against an archived workspace; read paths (list, history, AI summarize) still work; audit rows for both directions.

### 3. Self-service workspace subscription (discover + join)

**Status**: Proposed
**Utility**: Medium. The just-built invite endpoint (`POST /workspaces/:workspaceId/members`) covers "an admin adds a specific known person," but there's still no way for a user to find and join a workspace on their own — every workspace is effectively invite-only forever, with no equivalent of a `PUBLIC` channel's self-join. Matters more as the number of workspaces/users grows past a handful of admin-curated invites; less urgent than the two entries above at the app's current scale.
**Origin**: Requested directly. Interpreted as **self-service join for openly-discoverable workspaces**, mirroring how `PUBLIC` channels already work — flagging this interpretation explicitly in case "subscribe" was meant as a notification/digest feature (e.g. "notify me of activity in this workspace without being a full member") instead, which would be a materially different, smaller design (no new membership row, just a `workspace_subscriptions` notification-preferences table) and isn't what's designed below.

Design:
- **Schema**: add `visibility VARCHAR(20) NOT NULL DEFAULT 'PRIVATE'` to `workspaces` (new migration, can combine with the archiving migration above into one `0008_workspace_lifecycle.js` if both ship together), enum `PUBLIC`/`PRIVATE` — same values and spirit as `channels.type`'s `PUBLIC`/`PRIVATE`. Defaulting existing (and newly created, unless specified) workspaces to `PRIVATE` preserves today's actual behavior — nothing becomes discoverable by accident.
- **`POST /workspaces`** (existing endpoint) gains an optional `visibility` field in the request body, validated against a new `WORKSPACE_VISIBILITY = ['PUBLIC', 'PRIVATE']` enum (`validation.js`, alongside the existing `CREATABLE_CHANNEL_TYPES`), defaulting to `PRIVATE` if omitted.
- **`GET /workspaces/discoverable`** — lists `PUBLIC`-visibility workspaces the caller is *not* already a member of (so the browse list and the "your workspaces" list never overlap), same shape as the existing `GET /workspaces` response minus `role` (the caller has none yet).
- **`POST /workspaces/:workspaceId/subscribe`** — self-service join, authorized only by `visibility = 'PUBLIC'` (401/403 aren't right here; a `PRIVATE` workspace should 404 exactly like any other not-a-member case, per Section 3's existence-hiding convention — don't let this endpoint become a way to confirm a private workspace's existence). Inserts `workspace_members` with `system_role = 'MEMBER'`, exactly mirroring `channels/:id/join`'s "Only public channels can be self-joined" pattern and its `ValidationError` (400) when the target isn't `PUBLIC`. Must also check the archived-workspace gate from the entry above once that ships (an archived workspace shouldn't be self-joinable even if it was left `PUBLIC`).
- Audited as `WORKSPACE_MEMBERSHIP_CHANGE` (the same action type the invite endpoint already uses) with `payload: { action: 'subscribe' }`, distinguishing it from `action: 'add'` (admin-invited) in the same audit trail without a new action type.
- **Frontend**: a "Browse workspaces" view (own modal, matching the `AiSettingsPanel`/`AuditDashboard` pattern already established) listing `GET /workspaces/discoverable` results with a "Subscribe" button per row; the existing `+ New workspace` form gains a visibility toggle (default Private, matching the schema default).
- **Explicitly out of scope for this entry, but worth flagging as a natural companion**: a symmetric self-service **leave workspace** (unsubscribe) — without it, self-joining is a one-way door, which is an odd asymmetry for a self-service feature. Not designed here since it wasn't requested, but if this ships, revisit whether it should ship alongside it rather than as a separate later ask.
- Tests: subscribing to a `PUBLIC` workspace succeeds and is idempotent-safe (already-a-member → no duplicate row, matching the join-endpoint precedent); subscribing to a `PRIVATE` workspace (by a caller who isn't already a member — e.g. guessed or previously-seen id) 404s, not 400, per the existence-hiding note above; `GET /workspaces/discoverable` never includes a `PRIVATE` workspace or one the caller already belongs to; audit row present with the right `action` discriminator.
