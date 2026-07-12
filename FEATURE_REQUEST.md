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
