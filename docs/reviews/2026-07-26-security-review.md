# 2026-07-26 Security Review

Prompt: `docs/code-review-prompts.md` -> Security / Privacy / Authz / Data Leak Audit.

Scope reviewed from current source: backend auth/session code, REST and WebSocket authorization paths, message/search/entity/AI routes, audit logging, validation, migrations/grants, frontend rendering/token storage, and enclave-facing configuration.

## Findings

### Low: hot channel-history requests can amplify database work through per-row reply counts

`GET /api/channels/:channelId/messages` computes `reply_count` with a correlated subquery for every returned message row (`backend/src/routes/messages.js:54-75`). The lookup is indexed by `idx_messages_threading`, so this is not an obvious table-scan bug, but the endpoint is user-driven and authenticated users can repeatedly request channel history. On a hot or very large thread/channel, this creates one indexed child-count lookup per row returned.

Security impact is low and mostly availability-oriented: a normal feed read does extra bounded database work that could contribute to request amplification under load. Prefer pre-aggregating reply counts for the page with a grouped subquery/CTE joined once, or denormalizing a maintained reply count if thread traffic grows.

## Verified Controls

- Auth/session controls hold: async bcrypt with a minimum of 12 rounds, httpOnly refresh cookies scoped to `/api/auth`, in-memory frontend access tokens, refresh-token rotation with row locking, and reuse detection that revokes sibling refresh tokens.
- REST and WebSocket content access both use the shared membership gate. System admins get structural-management override only; message content still requires real channel membership.
- Archived workspace/org writes are blocked on current write paths reviewed, including invitation creation and redemption-time checks for token and in-app membership invitations.
- AI settings remain system-admin-only, `LLM_API_KEY` is env-only, admin-editable LLM origins are allowlisted, and prompt templates default to nonce-delimited JSON `v2`.
- Search, entity summaries, workspace digests, and analytics are scoped through workspace/channel membership joins before returning content-derived data.
- Audit events avoid raw sensitive content on message edits/AI/search paths, and audit-log chaining uses advisory locking for append serialization.
- Frontend message rendering builds React nodes directly; no runtime `dangerouslySetInnerHTML` sink is present in `frontend/src`.

## Residual Risk

The enclave/vLLM path is protected by installer-time checks, but this source pass did not run against real enclave hardware or staged image artifacts. That is covered in the enclave readiness review as an operational evidence gap, not a source-code authz finding.
