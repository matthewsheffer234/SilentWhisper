# Silent Whisper Security Review

Date: 2026-07-15

Scope reviewed: Node.js/Express backend, React frontend, PostgreSQL migrations, WebSocket server, auth/session logic, workspace/org/message routes, AI/semantic-search integration, notification changes, and dependency manifests.

Dependency check: `npm audit --json` returned 0 known vulnerabilities for both `backend` and `frontend`.

## Executive Summary

No confirmed RCE or unauthenticated database compromise was found. The highest-risk issues are authorization boundary problems:

- Any authenticated user can create a workspace, become `OWNER`, and thereby access global audit logs and mutate global AI settings through `requireSystemPermission`.
- The channel-member add endpoint does not bind `workspaceId` to `channelId`, allowing cross-workspace membership injection into channels.

The codebase has several strong controls already: parameterized Knex queries, httpOnly refresh cookies, in-memory access tokens, refresh-token rotation, message length limits, CSP without `unsafe-inline` scripts, no `dangerouslySetInnerHTML`, and a clean dependency audit.

---

## Critical/High Vulnerabilities

#### [Severity Rating: HIGH] - Self-Service Workspace Ownership Grants Global Audit/AI Administration

* **Location:** `backend/src/authz/membershipService.js`, `requireSystemPermission`, lines ~91-102; `backend/src/routes/audit.js`, lines ~27-82; `backend/src/routes/ai.js`, lines ~24-38; `backend/src/routes/workspaces.js`, workspace creation, lines ~61-87.

* **Description:** `requireSystemPermission` grants system-wide access if the caller is either a system admin or has `OWNER`/`MANAGER` in any workspace. Because any authenticated user can create a workspace and is inserted as `OWNER`, any user can self-escalate into global audit-log access and global AI-settings management. The affected surfaces are not workspace-scoped: audit logs include cross-tenant security metadata, and AI settings affect the whole deployment.

* **Exploit Scenario:**
  1. Attacker logs in as an ordinary user.
  2. Attacker creates a workspace via `POST /api/workspaces`, becoming `OWNER`.
  3. Attacker calls `GET /api/audit/logs` and receives global audit events, including actor IDs, IP addresses, target resources, and payload metadata across organizations/workspaces.
  4. Attacker calls `PATCH /api/ai/settings` and changes `baseUrl`, `provider`, model, timeout, or concurrency settings globally.

  Example:

  ```bash
  curl -s -X POST "$API/api/workspaces" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"attacker-owned"}'

  curl -s "$API/api/audit/logs" \
    -H "Authorization: Bearer $TOKEN"

  curl -s -X PATCH "$API/api/ai/settings" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"provider":"ollama","baseUrl":"http://127.0.0.1:80","timeoutMs":1000}'
  ```

* **Remediation:** Do not use workspace ownership as a fallback for global, unscoped surfaces. Gate global audit and global AI settings on `users.is_system_admin`, or introduce explicitly scoped permissions with tenant/resource boundaries.

  Recommended replacement:

  ```js
  // backend/src/authz/membershipService.js
  export async function requireSystemAdmin(db, userId) {
    if (!(await isSystemAdminUser(db, userId))) {
      throw new ForbiddenError('System admin privileges required');
    }
    return { viaSystemAdminOverride: true };
  }
  ```

  Apply it to global routes:

  ```js
  // backend/src/routes/audit.js
  import { requireSystemAdmin } from '../authz/membershipService.js';

  auditRouter.get('/audit/logs', async (req, res, next) => {
    try {
      await requireSystemAdmin(db, req.user.id);
      // existing audit query...
    } catch (err) {
      next(err);
    }
  });
  ```

  ```js
  // backend/src/routes/ai.js
  aiRouter.patch('/ai/settings', async (req, res, next) => {
    try {
      await requireSystemAdmin(db, req.user.id);
      const patch = validateSettingsPatch(req.body ?? {});
      const settings = await updateSettings(db, patch, req.user.id);
      res.json({ ...settings, health: getHealthStatus() });
    } catch (err) {
      next(err);
    }
  });
  ```

  If workspace admins must retain some audit capability, add a separate workspace-scoped audit endpoint that filters events by authorized workspace IDs and excludes global/system metadata.

---

#### [Severity Rating: HIGH] - Cross-Workspace Channel Membership Injection

* **Location:** `backend/src/routes/workspaces.js`, `POST /:workspaceId/channels/:channelId/members`, lines ~888-918.

* **Description:** The endpoint validates that the caller belongs to `channelId`, but then validates the target user's workspace membership against the independent `workspaceId` path parameter. It never verifies that `channelId` belongs to `workspaceId`. An attacker who belongs to a private channel in workspace A can pass a workspace B ID where their second account is a member, causing that second account to be added to the workspace A channel without being a member of workspace A.

* **Exploit Scenario:**
  1. Attacker account A is a legitimate member of private channel `channelA` in workspace A.
  2. Attacker account B is not a member of workspace A, but is a member of workspace B.
  3. Account A sends:

     ```bash
     curl -X POST "$API/api/workspaces/$workspaceB/channels/$channelA/members" \
       -H "Authorization: Bearer $TOKEN_A" \
       -H "Content-Type: application/json" \
       -d "{\"userId\":\"$attackerBUserId\"}"
     ```

  4. The route checks A is in `channelA`, checks B is in `workspaceB`, and inserts B into `channelA`.
  5. Account B can now read/send in a private channel from workspace A despite not being a workspace A member.

* **Remediation:** Bind the path parameters together before any target membership check. Use the channel's actual workspace ID for archive checks and target membership checks.

  Corrected code:

  ```js
  workspacesRouter.post('/:workspaceId/channels/:channelId/members', async (req, res, next) => {
    try {
      const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
      const channelId = assertUuid(req.params.channelId, 'channelId');
      const targetUserId = assertUuid(req.body?.userId, 'userId');

      const channel = await requireChannelMember(db, req.user.id, channelId);
      if (channel.workspace_id !== workspaceId) {
        throw new NotFoundError('Channel not found in this workspace');
      }

      await requireWorkspaceNotArchived(db, channel.workspace_id);

      const targetRole = await db('workspace_members')
        .where({ workspace_id: channel.workspace_id, user_id: targetUserId })
        .first();
      if (!targetRole) {
        throw new ValidationError('Target user is not a member of this workspace');
      }

      const alreadyMember = await isChannelMember(db, targetUserId, channelId);
      if (!alreadyMember) {
        await db('channel_members').insert({ channel_id: channelId, user_id: targetUserId });
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
  ```

  Add a regression test where `workspaceId` and `channelId` belong to different workspaces and assert the request fails without inserting `channel_members`.

---

## Medium/Low Vulnerabilities

#### [Severity Rating: MEDIUM] - Disabled Accounts Keep Using Valid Access Tokens and Existing WebSockets Until Expiry

* **Location:** `backend/src/auth/requireAuth.js`, lines ~8-18; `backend/src/ws/server.js`, `handleAuthenticate`, lines ~116-145; `backend/src/routes/admin.js`, disable route, lines ~146-148.

* **Description:** Disabling a user revokes refresh tokens, but REST and WebSocket authentication only verify the JWT signature/expiry. A disabled user's already-issued access token remains valid until its 15-minute expiry. Existing WebSocket sessions also remain usable until the token-expiry sweep disconnects them, and re-authentication with an unexpired access token is still accepted.

* **Exploit Scenario:**
  1. User is disabled by a system admin.
  2. User keeps an already-open tab or copies the current access token.
  3. Until access-token expiry, user can continue making REST calls and sending WebSocket messages.
  4. If the WebSocket is already authenticated, the user can keep interacting until the token sweep closes it.

* **Remediation:** Enforce active account status wherever identity is established, not just during login. Make `requireAuth` asynchronous and check `users.status`. Also check status in WebSocket `handleAuthenticate` and close existing sockets when disabling a user if practical.

  Corrected REST middleware:

  ```js
  // backend/src/auth/requireAuth.js
  import { db } from '../db.js';
  import { verifyAccessToken } from './jwt.js';
  import { UnauthorizedError } from '../errors.js';

  export async function requireAuth(req, _res, next) {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      next(new UnauthorizedError('Missing bearer token'));
      return;
    }

    try {
      const { userId, username } = verifyAccessToken(token);
      const user = await db('users').where({ id: userId }).first('id', 'status');
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedError('Invalid or expired access token');
      }
      req.user = { id: userId, username };
      next();
    } catch (err) {
      next(err);
    }
  }
  ```

  Corrected WebSocket authentication:

  ```js
  async function handleAuthenticate(ws, frame) {
    let claims;
    try {
      claims = verifyAccessToken(frame.accessToken);
      const user = await db('users').where({ id: claims.userId }).first('status');
      if (!user || user.status !== 'ACTIVE') {
        throw new Error('inactive');
      }
    } catch {
      sendError(ws, 'Invalid or expired access token', 'authenticate');
      ws.close(4001, 'Invalid token');
      return;
    }
    // existing identity/connection-limit logic...
  }
  ```

---

#### [Severity Rating: MEDIUM] - LLM Base URL Allows Backend-Side SSRF and Global AI DoS

* **Location:** `backend/src/llm/settingsService.js`, `validateSettingsPatch`, lines ~88-109; `backend/src/llm/adapters/ollamaAdapter.js`, outbound `fetch` calls; `backend/src/llm/adapters/vllmAdapter.js`, outbound `fetch` calls; `backend/src/routes/ai.js`, lines ~34-38.

* **Description:** `baseUrl` is admin-editable and only validated as syntactically valid `http(s)`. The backend then sends requests to `${baseUrl}/api/generate`, `/api/embeddings`, `/api/tags`, `/v1/completions`, `/v1/embeddings`, or `/v1/models`. Combined with the authorization issue above, this is exploitable by ordinary users; even after tightening authorization, a compromised admin account can use the app as an SSRF primitive against loopback, metadata endpoints, internal admin panels, or local services. It can also globally break AI/search by pointing the provider at a blackhole or slow endpoint.

* **Exploit Scenario:**
  1. Attacker gains access to AI settings.
  2. Attacker sets `baseUrl` to an internal target:

     ```bash
     curl -X PATCH "$API/api/ai/settings" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"provider":"ollama","baseUrl":"http://127.0.0.1:8080","timeoutMs":120000}'
     ```

  3. Attacker triggers summarize/search operations, causing backend-originated requests to internal services.
  4. Depending on the internal service behavior, attacker can observe status/error differences, cause state-changing POSTs to fixed paths, or deny AI/search service for all users.

* **Remediation:** Treat provider endpoints as deployment configuration, not arbitrary runtime input. Prefer an allowlist of known provider origins or a network-layer egress policy. Reject loopback, link-local, private metadata ranges, and non-approved hostnames unless explicitly configured.

  Example allowlist approach:

  ```js
  // backend/src/validation.js
  const ALLOWED_LLM_ORIGINS = new Set(
    (process.env.ALLOWED_LLM_ORIGINS || 'http://silent-whisper-ollama:11434')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  export function assertAllowedLlmUrl(value, label = 'baseUrl') {
    const parsed = new URL(assertHttpUrl(value, label));
    if (!ALLOWED_LLM_ORIGINS.has(parsed.origin)) {
      throw new ValidationError(`${label} is not an approved LLM provider origin`);
    }
    return parsed.origin;
  }
  ```

  Then use it in `validateSettingsPatch`:

  ```js
  if ('baseUrl' in body) {
    patch.baseUrl = assertAllowedLlmUrl(body.baseUrl, 'baseUrl');
  }
  ```

  Also enforce container/network egress restrictions so the backend can only reach PostgreSQL, the configured LLM service, and explicitly required internal hosts.

---

#### [Severity Rating: MEDIUM] - Archived Workspace/Organization Invitations Remain Redeemable

* **Location:** `backend/src/routes/invitations.js`, `POST /:token/accept`, lines ~76-115.

* **Description:** Invitation creation checks archived state, but redemption does not re-check whether the target workspace or organization has since been archived. A pending invitation created before archival can still create a new user and attach membership to an archived workspace/org, bypassing the write-freeze semantics enforced by direct member-add endpoints.

* **Exploit Scenario:**
  1. Manager creates a workspace or organization invitation while the resource is active.
  2. Admin archives that workspace/org to freeze membership changes.
  3. Invitee redeems the old token.
  4. The accept route inserts `workspace_members` or `organization_members` anyway.

* **Remediation:** In the row-locked transaction, fetch and validate the invited scope state before creating the user or inserting membership. Return the same generic invalid invitation error to avoid leaking extra state from the public endpoint.

  Corrected transaction fragment:

  ```js
  const row = await trx('invitations').where({ token_hash: tokenHash }).forUpdate().first();
  if (!row || row.status !== 'PENDING' || new Date(row.expires_at) < new Date()) {
    return { kind: 'invalid' };
  }

  if (row.scope_type === 'ORGANIZATION') {
    const org = await trx('organizations').where({ id: row.organization_id }).first('archived_at');
    if (!org || org.archived_at) return { kind: 'invalid' };
  } else {
    const workspace = await trx('workspaces').where({ id: row.workspace_id }).first('archived_at');
    if (!workspace || workspace.archived_at) return { kind: 'invalid' };
  }
  ```

  Add regression tests for accepting an invitation after workspace archive and after organization archive.

---

#### [Severity Rating: MEDIUM] - WebSocket Server Has No Explicit Payload Limit Before JSON Parsing

* **Location:** `backend/src/ws/server.js`, `attachWebSocketServer`, lines ~36-49; `backend/src/config.js`, WebSocket settings, lines ~121-126.

* **Description:** The WebSocket server is created without an explicit `maxPayload`. The `ws` package default is large relative to this application's expected frame size, and incoming frames are converted to string and JSON-parsed before any authentication, room membership, or message rate limit is applied. An unauthenticated attacker can repeatedly open sockets and send very large frames, causing memory and CPU pressure.

* **Exploit Scenario:**
  1. Attacker opens many WebSocket connections to `/ws`.
  2. Attacker sends large unauthenticated frames.
  3. Server buffers, converts, and attempts to parse them before closing/rejecting.
  4. CPU/memory pressure degrades service for legitimate users.

* **Remediation:** Add a low `maxPayload` that fits the largest legitimate frame. Message content is limited to 10,000 characters, so 16-32 KiB is sufficient for auth/message frames. Close connections on malformed frames rather than keeping unauthenticated clients open.

  Corrected code:

  ```js
  // backend/src/config.js
  ws: {
    // ...
    maxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES || 32 * 1024),
  }
  ```

  ```js
  // backend/src/ws/server.js
  const wss = new WebSocketServer({
    server: httpServer,
    path: config.ws.path,
    maxPayload: config.ws.maxPayloadBytes,
  });

  ws.on('message', async (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(ws, 'Malformed frame');
      ws.close(4000, 'Malformed frame');
      return;
    }
    // existing logic...
  });
  ```

---

#### [Severity Rating: LOW] - Group DM Creation Allows Unbounded Member Arrays

* **Location:** `backend/src/routes/directMessages.js`, `groupDirectMessagesRouter.post('/')`, lines ~78-109.

* **Description:** `memberIds` is only checked for non-empty array and valid UUID syntax. There is no maximum length. An authenticated attacker can submit a very large array, forcing large `whereIn` queries and attempted inserts. This is self-authenticated abuse rather than a direct data breach, but it is an avoidable DoS vector.

* **Exploit Scenario:**
  1. Attacker sends `POST /api/group-direct-messages` with thousands of UUIDs.
  2. Server deduplicates and validates them in memory.
  3. Server performs a large `whereIn` query and may attempt a large insert.

* **Remediation:** Add a small, product-level cap for group DMs.

  Corrected code:

  ```js
  const MAX_GROUP_DM_MEMBERS = 20;

  groupDirectMessagesRouter.post('/', async (req, res, next) => {
    try {
      const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : null;
      if (!memberIds || memberIds.length === 0) {
        throw new ValidationError('memberIds must be a non-empty array');
      }
      if (memberIds.length > MAX_GROUP_DM_MEMBERS) {
        throw new ValidationError(`memberIds must include at most ${MAX_GROUP_DM_MEMBERS} users`);
      }
      // existing logic...
    } catch (err) {
      next(err);
    }
  });
  ```

---

## Informational / Defense-in-Depth Notes

#### [Severity Rating: INFO] - Dependency Audit Is Currently Clean

* **Location:** `backend/package.json`, `frontend/package.json`.
* **Description:** `npm audit --json` reported zero known vulnerabilities in both backend and frontend dependency trees at review time.
* **Exploit Scenario:** None currently identified from `npm audit`.
* **Remediation:** Keep running `npm audit` in CI and before dependency-changing commits. Consider adding automated dependency review so this does not depend on manual checks.

#### [Severity Rating: INFO] - XSS and SQL Injection Posture Is Generally Strong

* **Location:** `frontend/src/markdown.jsx`; backend routes and services using Knex.
* **Description:** Message rendering returns React nodes and does not use `dangerouslySetInnerHTML`. Links are limited to `http`/`https` and use `rel="noopener noreferrer"`. SQL access is mostly built through Knex query builders and parameterized `raw` bindings.
* **Exploit Scenario:** No direct XSS/SQLi exploit was confirmed in reviewed code.
* **Remediation:** Preserve the current rule: never render message/model output as raw HTML, and keep all raw SQL parameterized.

