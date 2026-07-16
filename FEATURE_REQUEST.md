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

Dependency note: the UI/UX entries below are ordered so low-risk language cleanup and shared primitives land before larger workflow rewrites. In particular, display names should land before people picker work; the people picker should land before private-channel membership, direct messages, and private-channel creation flows; the shared modal/sheet primitive should land before moving inline sidebar forms into sheets; and the broad sidebar redesign should land after the destination surfaces it depends on exist.

### 1. Security hardening from 2026-07-15 audit

**Status**: Proposed
**Utility**: Critical. This closes the highest-risk findings from `Security.md`: global authorization overreach, cross-workspace channel membership injection, disabled-account access windows, provider SSRF/DoS risk, stale invitation redemption, and avoidable WebSocket/group-DM DoS edges.
**Origin**: Requested after the Principal AppSec review was written to `Security.md` on 2026-07-15. Prioritized above product features because two findings are High severity authorization vulnerabilities and several Medium findings affect account lifecycle or backend availability.

Design:
- **Global admin boundary**: replace `requireSystemPermission`'s "system admin OR OWNER/MANAGER in any workspace" fallback for unscoped global surfaces with a direct `is_system_admin` gate. At minimum, `GET /api/audit/logs`, `POST /api/audit/verify`, `GET /api/ai/settings`, and `PATCH /api/ai/settings` must require system-admin status. If workspace owners/managers still need audit visibility, add a separate workspace-scoped audit endpoint whose query is filtered to authorized workspace ids and excludes global/system metadata; do not reuse the current global audit endpoint.
- **Cross-workspace channel-member injection fix**: update `POST /api/workspaces/:workspaceId/channels/:channelId/members` so it proves `channel.workspace_id === workspaceId` after `requireChannelMember`, then uses `channel.workspace_id` for `requireWorkspaceNotArchived` and the target user's `workspace_members` lookup. A mismatched workspace/channel pair should fail without inserting `channel_members`.
- **Disabled-account enforcement**: make `requireAuth` status-aware by checking `users.status === 'ACTIVE'` after JWT verification. Mirror the same check in WebSocket `handleAuthenticate`, including re-authentication frames, and close/reject inactive users with the same generic invalid-token behavior. Consider adding a connection-registry helper to disconnect all active sockets for a user at disable-time, so admin disable takes effect immediately rather than waiting for token expiry.
- **LLM provider SSRF/DoS control**: treat `llm.baseUrl` as an allowlisted provider origin, not an arbitrary admin-supplied URL. Add an `ALLOWED_LLM_ORIGINS` env var or equivalent config, normalize `baseUrl` to an origin, and reject loopback/link-local/private metadata targets unless explicitly listed. Keep network egress restricted at the container/network layer where possible. This also reduces global AI outage risk from accidentally pointing the provider at a blackhole or unrelated internal service.
- **Archived invitation redemption**: in `POST /api/invitations/:token/accept`, after row-locking the invitation and before creating the user, re-check that the target workspace or organization still exists and is not archived. Return the same generic "Invitation not found" response for archived/revoked/expired/nonexistent cases from this public endpoint.
- **WebSocket payload cap**: add a configurable `WS_MAX_PAYLOAD_BYTES` with a conservative default such as 32 KiB and pass it to `new WebSocketServer({ maxPayload })`. Close malformed unauthenticated frames after sending the error so unauthenticated clients cannot repeatedly force large JSON parsing work.
- **Group DM member cap**: add a product-level maximum for `memberIds` in `POST /api/group-direct-messages`, e.g. 20 users, before UUID validation/database lookup. This is a low-severity authenticated DoS hardening item but cheap to close with the rest.
- **Audit and compatibility**: global admin-boundary tightening is a deliberate behavior change. Document it in `PROJECT_PLAN.md` Section 11 when shipped. Existing audit event types can remain; add new audit rows only for any new admin-scoped endpoint introduced, not for ordinary denied attempts.
- **Tests**: add backend tests proving ordinary workspace owners/managers cannot access global audit/AI settings; system admins still can; mismatched workspace/channel member-add fails and does not create membership; disabled users cannot use REST or WS with still-unexpired access tokens; archived workspace/org invitations cannot be redeemed; oversized WebSocket frames are rejected; oversized group-DM member arrays 400. Regression-run existing auth, admin, workspace, invitations, WebSocket, audit, AI settings, and mention notification tests.

### 2. Channel details panel with private-channel member management

**Status**: Proposed
**Utility**: High. Private-channel membership is currently hidden behind a channel row overflow menu and an inline username form. Users should manage channel membership and understand channel context from the channel they are viewing.
**Origin**: `UI_UX_REVIEW.md` recommendations for private-channel membership, channel header context, breadcrumbs, and archived/read-only state. Merged because the same channel header/details surface should carry all of this context instead of creating two overlapping header refactors.

Design:
- **Entry point**: add a details/info button in `ChannelView.jsx`'s header. The header should show channel name, open/private state, member count, and archived/read-only state, with details opening a right-side panel or modal sheet.
- **Panel content**: show channel name, privacy, optional description, member count, member list with display names/presence, and an "Add People" action when the caller can add members. Show current workspace context in or near the header when it is not visually obvious, especially after search or mention navigation jumps across workspaces.
- **Add people**: use the unified people picker. For private channels, only eligible workspace members should be selectable. Public channels continue to support self-service join.
- **Authorization**: reuse existing `requireChannelMember` and workspace membership checks. The UI should hide add controls when not allowed, but backend remains authoritative.
- **Archived state**: archived workspace channels render details read-only, disable membership changes, and show read-only state in the header and composer, not only in the sidebar section label.
- **Search/navigation consistency**: when navigating to a result from another workspace, update visible workspace/channel state consistently. Avoid the existing noted gap for workspace-less DM/group-DM channels once DM navigation exists.
- **Tests**: backend tests for any new channel-members listing endpoint; frontend/e2e tests for viewing members, adding a person to a private channel, archived read-only behavior, cross-workspace search navigation, private vs. open channel header labels, and lack of leakage to non-members.

### 3. Focused creation sheets for workspaces and channels

**Status**: Proposed
**Utility**: High. Inline creation forms compress important choices into the sidebar, making workspace/channel creation feel easy to misconfigure. Sheets give naming, visibility, and membership choices enough room to be understood.
**Origin**: `UI_UX_REVIEW.md` recommendation after reviewing the inline `InlineCreateForm` usage in `WorkspaceSidebar.jsx`.

Design:
- **Create workspace sheet**: fields for name, organization only when the user has more than one, visibility with clear user-facing labels, and a concise explanation of who can join. Primary action: "Create Workspace"; secondary: "Cancel."
- **Create channel sheet**: fields for name, optional purpose/description if added to schema, privacy, and optional initial invitees for private channels through the people picker.
- **Validation**: show inline validation before submit for empty names, too-long names, invalid characters if any are enforced, and duplicate names if backend returns a conflict.
- **State handling**: avoid backdrop-click data loss for dirty forms, or confirm before closing.
- **Compatibility**: keep existing create endpoints initially. Add description/initial-members support only if the backend schema/API is extended in the same feature slice.
- **Tests**: e2e tests for creating listed/invite-only workspaces, open/private channels, cancellation, validation, and private channel creation with initial members if implemented.

### 4. Dedicated admin/settings area

**Status**: Proposed
**Utility**: Medium-high. Admin actions should not dominate daily chat navigation. Moving them into a distinct area lowers cognitive load while preserving privileged workflows.
**Origin**: `UI_UX_REVIEW.md` recommendation after reviewing `WorkspaceSidebar.jsx`, `UserManagementPanel.jsx`, `OrgManagementPanel.jsx`, `AiSettingsPanel.jsx`, and `AuditDashboard.jsx`.

Design:
- **User menu**: keep profile, mentions, notifications, appearance, change password, and sign out.
- **Workspace settings**: create a workspace-scoped settings surface with members, invitations, visibility, ownership transfer, and archive actions, visible according to workspace permissions.
- **Admin area**: create a separate privileged entry point for organization administration, system user administration, AI settings, audit log, and system administration.
- **Permissions**: mirror backend gates precisely. System-only routes remain system-only; workspace-scoped settings require workspace permissions.
- **Navigation**: admin/settings surfaces may be modal sheets initially, but should share consistent layout and not live as permanent sidebar rows.
- **Tests**: e2e tests for visibility by role: non-admin member, workspace manager/owner, organization admin, and system admin.

### 5. Confirmation and recovery for destructive or high-impact actions

**Status**: Proposed
**Utility**: Medium-high. Archive, remove member, revoke invitation, transfer ownership, password reset, and account disable actions can surprise users if triggered by a single click.
**Origin**: `UI_UX_REVIEW.md` recommendation.

Design:
- **Confirmations**: require confirmation for destructive/high-impact actions with specific object names and consequences, e.g. "Archive Workspace," "Remove Maria Chen," "Revoke Invitation," "Transfer Ownership," "Reset Password," and "Disable Account."
- **Action taxonomy**: use confirmation for irreversible or security-impacting actions; use undo/toast for lower-risk reversible changes where feasible.
- **Copy**: avoid vague labels like "Remove" without context. Confirmation body should explain what changes and who is affected.
- **Audit**: no new audit event type required if the underlying action is already audited. Ensure cancelled confirmations do not audit.
- **Tests**: e2e tests for each destructive flow proving cancel does nothing and confirm performs the action.

### 6. Workspace home and actionable empty states

**Status**: Proposed
**Utility**: High. "Select a channel to get started" leaves new or lightly used workspaces feeling blank. A workspace home explains the current context and offers the next likely actions.
**Origin**: `UI_UX_REVIEW.md` recommendation.

Design:
- **Workspace home**: when a workspace is selected and no channel is selected, render a workspace overview in the main pane instead of a generic empty message.
- **Content**: show workspace name, archived/read-only state, channel list or recent activity if available, and permission-aware actions such as "Create Channel," "Invite People," and "Join a Workspace."
- **First-run state**: for a brand-new workspace, prioritize "Create your first channel" and "Invite teammates."
- **Permissions**: actions should reflect the caller's role. Non-admins should see available channels and join/discovery options, not disabled admin controls.
- **Data**: use already-loaded workspace/channel data first; avoid adding a heavy dashboard query unless recent activity is included.
- **Tests**: frontend/e2e coverage for no channel selected, empty new workspace, archived workspace, and member vs. manager/owner action visibility.

### 7. Default workspace on login

**Status**: Proposed
**Utility**: Medium. Today, `ChatShell.jsx`'s initial-load effect (`frontend/src/components/ChatShell.jsx:174-177`) auto-selects `ws[0].id` — whichever workspace `GET /workspaces` happens to return first (`ORDER BY created_at ASC`, i.e. oldest-joined), not a deliberate choice. For a user in exactly one workspace this is already a no-op (there's only one candidate), but for anyone in two or more it's arbitrary — the main window can land on a stale or rarely-used workspace, leaving the message pane empty until the user manually clicks the one they actually wanted. Letting them pin a specific workspace fixes that dead-space-on-startup gap directly.
**Origin**: Requested directly, framed around minimizing empty main-window space on startup. Interpreted as an **explicit, persistent, user-chosen default** (a deliberate pin, surviving across logins/devices) — distinct from a simpler "just remember whatever I looked at last" session-based approach, which the request's wording ("select a default workspace") doesn't actually ask for; flagging the distinction the same way past entries have flagged their own interpretation calls.

Design:
- **Schema**: add `default_workspace_id UUID NULL REFERENCES workspaces(id) ON DELETE SET NULL` to `users` in the next available migration. Nullable, defaulting to `NULL` for every existing and newly-created user, preserving today's `ws[0]` fallback behavior for anyone who never sets one. `ON DELETE SET NULL` rather than a hard block: there's no workspace-delete endpoint today (only archive/unarchive), so this is future-proofing, not a live concern, but a stale FK silently blocking an unrelated future delete would be a surprising failure mode for a feature this minor.
- **Setting it**: `PUT /api/auth/me/default-workspace`, behind `requireAuth`, body `{ workspaceId: <uuid> | null }` (`null` clears it, reverting to the `ws[0]` fallback). Validates the target via `requireWorkspaceMember` (`authz/membershipService.js`) before storing it — same existence-hiding 404 for a non-member/nonexistent workspace as every other membership-gated route, so this can't be used to confirm a private workspace's existence or pin a workspace the caller doesn't actually belong to. No admin/role requirement beyond plain membership — this is a personal preference about the caller's own view, not a workspace-administration action, so any member (not just `ADMIN`) can set it for themselves. Returns `{ user }` (the same `{ id, username, email, defaultWorkspaceId }` shape below), mirroring `POST /auth/change-password`'s existing "return the updated user/session state" pattern.
- **Surfacing it**: add `default_workspace_id` (as `defaultWorkspaceId`) to the user object returned by `GET /api/auth/me`, `POST /api/auth/login`, and `POST /api/auth/signup` (`backend/src/routes/auth.js`) — the same three places that already return `{ id, username, email }`. This means `AuthContext.jsx`'s existing `user` state carries it through session-restore-on-reload for free, with no new fetch needed.
- **Not audited**: unlike membership/role changes, this doesn't affect authorization or any other user, and doesn't fit the audit log's existing scope (security-relevant events — failed logins, membership/role changes, admin actions, AI operations per `PROJECT_PLAN.md` Section 4's Forensic Security Audit Log). Treated the same as any other cosmetic personal preference — not every state change in this app is an audit event, and this one isn't security-relevant enough to be one.
- **Not rate-limited**: a personal single-value preference update, same class of "not attacker-interesting, not separately limited" as workspace/channel creation.
- **Frontend — control**: `WorkspaceSidebar.jsx`'s existing per-workspace "•••" overflow menu (`workspaceMenuItems`, `frontend/src/components/WorkspaceSidebar.jsx:410-413`, which already holds Invite/Archive) gains one more entry — a `checked`-style item (reusing `Menu.jsx`'s existing `menuitemcheckbox` rendering, the same mechanism the Light/Dark toggle entry already uses) labeled "Default workspace", `checked: ws.id === user.defaultWorkspaceId`. Selecting it when unchecked sets that workspace as the default; selecting it when already checked clears it (sends `null`) — a toggle, not a one-way pin, available to every member regardless of role (unlike Invite/Archive, which stay role-gated). `AuthContext.jsx` gains a `setDefaultWorkspace(workspaceId)` method (mirroring how `changePassword` already wraps its own API call and updates `user` state) so the sidebar's checkmark and any other `user.defaultWorkspaceId` read update immediately, without a page reload.
- **Frontend — applying it on load**: `ChatShell.jsx`'s initial-load effect (line 174-177 today) changes from unconditionally picking `ws[0].id` to: if `user.defaultWorkspaceId` is set *and* present in the just-fetched `ws` list (defends against a default pointing at a workspace the user has since lost membership in — no separate cleanup job needed, this check is cheap and already has the list in hand), select it; otherwise fall back to `ws[0].id` exactly as today.
- **Tests**: setting a default on a workspace the caller belongs to succeeds and is reflected in `GET /api/auth/me`/login/signup responses; setting it on a workspace the caller isn't a member of 404s (existence-hiding, not 403); setting `null` clears it; a plain `MEMBER` (not just `ADMIN`) can set their own default; the frontend's initial-selection logic prefers a valid `defaultWorkspaceId` over `ws[0]` when both are present, and falls back to `ws[0]` when the stored default is no longer in the caller's workspace list (e.g. removed from that workspace since setting it).

### 8. Direct Messages as a first-class navigation section

**Status**: Proposed
**Utility**: High. The backend has direct-message and group-DM routes, but the UI has no DM browsing surface. A messaging product feels incomplete when person-to-person conversations are invisible in navigation.
**Origin**: `UI_UX_REVIEW.md` recommendation and existing `ChatShell.jsx` comment noting no DM-browsing UI exists yet.

Design:
- **Navigation**: add a "Direct Messages" section below channels or in a separate sidebar segment. Rows should show display names for one-to-one DMs and member names for group DMs.
- **New message flow**: add a "New Message" action using the people picker. One selected person creates/opens a direct DM; multiple selected people create a group DM.
- **API support**: add listing endpoints if missing, returning DM/group-DM channels the caller belongs to, member summaries, last activity, unread counts when available, and display names.
- **Selection behavior**: selecting a DM uses the existing `ChannelView` message surface but should not require a workspace highlight. Header copy should reflect people, not `#channel`.
- **Privacy**: DMs and group DMs remain membership-only and workspace-independent per existing backend model.
- **Tests**: backend tests for DM listing authorization; e2e tests for starting a DM, reopening an existing DM, starting a group DM, and navigating between workspace channels and DMs.

### 9. Navigation-first sidebar redesign

**Status**: Proposed
**Utility**: High. The sidebar currently mixes account controls, search, admin tools, organization switching, workspace navigation, workspace management, channel navigation, creation forms, invitations, and channel membership. Reducing it to navigation-first behavior directly addresses the user's workflow confusion.
**Origin**: `UI_UX_REVIEW.md` recommendation after reviewing `WorkspaceSidebar.jsx`.

Design:
- **Primary purpose**: keep the sidebar focused on "where am I?" and "where can I go?" Keep account menu, search, workspace switcher/list, channels, DMs, unread/mention indicators, and minimal create/join entry points.
- **Move actions out**: remove inline invite forms, ownership transfer forms, workspace settings toggles, private-channel member add forms, and destructive actions from the visible sidebar body. These move to workspace settings, channel details, or admin/settings surfaces.
- **Workspace row menu**: keep a compact overflow menu for low-frequency workspace actions, but route actions to full sheets rather than expanding inline forms under rows.
- **Admin controls**: remove the always-visible `Admin Tools` row from ordinary navigation rhythm; expose it through a distinct admin/settings area.
- **Responsive behavior**: maintain 44px minimum touch targets and ensure long names truncate predictably without hiding critical badges.
- **Tests**: update e2e workflows that currently open inline sidebar forms. Add tests proving navigation remains usable with many workspaces/channels and admin controls do not appear for non-privileged users.

### 10. Message presentation improvements for team scanability

**Status**: Proposed
**Utility**: Medium. The current iMessage-style bubbles are friendly, but team channels need fast scanning by author, thread activity, and context. This entry tunes message presentation without undoing the existing bubble work prematurely.
**Origin**: `UI_UX_REVIEW.md` recommendation.

Design:
- **Identity**: render display names and optional initials/avatar markers for other users' messages.
- **Grouping**: group consecutive messages from the same sender more strongly. Show author/avatar on the first message in a run, with reduced repetition on following messages.
- **Threads**: replace always-visible "Reply in thread" text with a more compact thread affordance showing reply count/activity where available.
- **Alignment experiment**: evaluate left-aligning all channel messages while reserving right-aligned bubbles for DMs. Treat this as a product/design decision to validate rather than an automatic rewrite.
- **Data**: add reply counts/last reply metadata to message list responses if needed; keep pagination bounded.
- **Tests**: frontend tests for grouping and author display; backend tests if reply-count metadata is added; visual/e2e checks for long names and mobile-width layouts.

### 11. Contextual AI action menu and clearer AI output scope

**Status**: Proposed
**Utility**: Medium. Channel summaries and thread task extraction are useful, but direct header buttons compete with channel context controls. Grouping AI actions makes them available without making them the primary object of the interface.
**Origin**: `UI_UX_REVIEW.md` recommendation after reviewing `ChannelView.jsx` and `ThreadSidebar.jsx`.

Design:
- **Action placement**: move `Summarize` and `Extract Tasks` into an AI/action menu in the channel/thread header. Keep actions visible enough for admins/users to find, but secondary to channel details and navigation.
- **Specific labels**: use "Summarize Recent Messages" and "Find Action Items" instead of generic or overly technical labels.
- **Scope display**: show the scope before or during execution, such as "Last 50 messages" or "This thread." If configurable, expose the limit in a lightweight control.
- **Provider state**: show disabled/unavailable/queued states when the local LLM provider is down or concurrency is saturated.
- **Output treatment**: generated summaries/tasks remain dismissible panels, visually distinct from human messages, and rendered through existing safe markdown/text handling.
- **Audit/rate limits**: reuse existing AI audit and concurrency conventions.
- **Tests**: frontend/e2e tests for menu placement, loading/unavailable states, scope text, streaming output, and dismissal.

### 12. Cross-channel "Catch Me Up" workspace digests

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

## Done

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
