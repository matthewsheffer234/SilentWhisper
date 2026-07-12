# Silent Whisper Project Plan

## 1. Project Overview

Silent Whisper is an offline-first, workspace-based messaging platform for project teams. It combines Slack-style channels, direct messages, group conversations, deep threaded replies, server-side presence, immutable audit logging, and configurable local LLM-powered AI utilities.

The system must run fully on local or intranet infrastructure. It must not depend on external CDNs, externally hosted assets, or public AI APIs.

Silent Whisper must also be deployable on the same server as the existing Silent Lattice stack described in `/root/wireservice/PROJECT_CONTEXT.md`. It should be able to run as an independently built app while being served through the same shared nginx entrypoint (`wireservice-nginx-1`), on its own dedicated hostname: `whisper.silentlattice.dev`.

**Target scale**: up to 100 concurrent users on a single backend instance. This number is a load-bearing design constraint, not a rough guess — see Scalability Target below. It determines whether in-process state (presence, rate limiting) is acceptable or whether a shared store is required.

## 2. Target Architecture

### Monorepo Layout

```text
/frontend   Vite + React client application
/backend    Node.js API, WebSocket server, auth, audit, and configurable LLM proxy
/database   PostgreSQL schema, migrations, grants, and seed data
/scripts    audit verification and local maintenance utilities
```

### Core Services

- PostgreSQL stores users, workspaces, channels, messages, memberships, refresh tokens, and audit logs.
- Node.js exposes REST APIs for auth, workspace/channel management, message pagination, admin audit views, and AI actions.
- WebSockets handle real-time messages, thread updates, room membership state, and presence heartbeats.
- React renders the 3-column messaging interface and admin tooling.
- Local LLM services are accessed only through a backend AI provider proxy.

### Scalability Target

- The system must support up to 100 concurrent active users (concurrent WebSocket connections plus concurrent REST traffic) on a **single** backend instance. Design for this explicitly rather than leaving it implicit.
- Presence and room-membership state may live in backend process memory because the deployment target is a single Node.js instance. Do not introduce a multi-instance requirement (PM2 cluster mode, horizontal replicas) without also introducing a shared state store (e.g., Redis pub/sub) for presence and WebSocket fan-out — a single instance with in-memory state and a multi-instance deployment without shared state are the two failure modes to avoid.
- Size the PostgreSQL connection pool (`pg` Pool `max`) to comfortably serve 100 concurrent users without exhausting `PGDATABASE`'s `max_connections`, and leave headroom for the existing Silent Lattice services (Oracle, Elasticsearch, Ollama, API/frontend containers) sharing the same host. Default to `max: 20` (up to `30` if profiling shows queueing) rather than sizing the pool to the user count 1:1 — Node's async event loop multiplexes many concurrent browser connections through a small number of pooled DB connections without saturating Postgres, and an oversized pool just burns Postgres memory/backend processes for no throughput gain at this scale.
- Add covering indexes for every authorization-check query path (membership lookups by `user_id`) so per-request authorization does not degrade as usage grows — see PostgreSQL Schema.
- Paginate all message history queries server-side; never return unbounded result sets regardless of channel size.
- Load-test the WebSocket and REST layers at 100 simulated concurrent users before Phase 5 is considered complete, and record observed p95 message-delivery latency and API response times as a baseline for future capacity planning.
- If usage is expected to exceed 100 concurrent users later, treat that as a distinct scaling milestone (shared presence store, sticky-session load balancing, connection-pool retuning) rather than assuming the current design silently scales further.

### Local Test Environment Resource Envelope

This host has 8 vCPU, 30GB RAM (~21GB free at last check), no GPU, and 108GB free disk — checked directly against `docker stats` output for the existing Silent Lattice containers before sizing the numbers below, rather than guessed. Memory is not the binding constraint for Silent Whisper's own footprint here; CPU concurrency for local LLM inference is (see Configurable LLM Provider Settings and `LLM_MAX_CONCURRENT_REQUESTS`, above). Set explicit `mem_limit`/`cpus` per service in Compose, matching the pattern `~/wireservice-dev/docker-compose.yml` already uses (its `api` container is capped at 3GB, `worker` at 2GB, `elasticsearch` at ~1.5GB):

| Service | Suggested limit | Rationale |
|---|---|---|
| PostgreSQL | 512MB–1GB RAM | small dataset at test scale; default `shared_buffers` (~128MB) is plenty; `max_connections` at its default (100) comfortably covers a `pg` pool of 20–30 |
| Node backend | 512MB RAM, no CPU cap | lean app, mostly async I/O bound; the only CPU-heavy op is bcrypt hashing, which is bounded and infrequent |
| Frontend (built static assets) | 128MB RAM | static bundle only, no SSR |
| Dedicated Ollama instance | 6GB RAM, no CPU cap | ~4.4GB on-disk model (`mistral` Q4_K_M, same one Silent Lattice's own Ollama containers already run here) plus working memory while generating |

Total new footprint when AI features are actively generating: roughly 6.5–8GB RAM, well inside the ~21GB currently free alongside Oracle, Elasticsearch, and Silent Lattice's two existing Ollama containers. Disk: the Ollama model pull plus Postgres data and Docker images fit comfortably in the 108GB free. If this later moves to the GPU-backed production network with vLLM, revisit these numbers — vLLM's memory/VRAM sizing is a separate question tied to whatever model and GPU are used there, out of scope for this test-environment sizing.

### Serving Under Silent Lattice

The current main server uses a Docker Compose stack behind the persistent `wireservice-nginx-1` reverse proxy, defined in `/root/wireservice/nginx/nginx.conf`. That file currently has two `server_name` blocks — `silentlattice.dev`/`www.silentlattice.dev` and `dev.silentlattice.dev` — each with its own certbot cert directory under `/etc/letsencrypt/live/`. Silent Whisper is served as a **third, dedicated `server_name` block** for `whisper.silentlattice.dev`, not as a path prefix under an existing domain. This means Silent Whisper owns `/`, `/api`, `/ws`, and `/health` outright on its own hostname — it does not need to coexist with Silent Lattice's routes on the same origin.

- Do not develop directly in `~/wireservice`; use the appropriate development repo or the Silent Whisper repo, then promote deliberately.
- **Network integration pattern**: this host already runs two different patterns side by side — prod (`~/wireservice`) joins `wireservice_default` directly and nginx proxies via service name (`http://frontend:3000`); dev (`~/wireservice-dev`) is on its own separate compose network and nginx instead reaches it via `http://host.docker.internal:3001`/`:8001` published host ports. Silent Whisper follows the **dev pattern**: its own independent Docker Compose stack/network, not joined to `wireservice_default`, reached by nginx via `host.docker.internal:<published-port>`. This matches the precedent for an independently-built app on this host and avoids coupling Silent Whisper's compose lifecycle to the prod stack's.
- Publish Silent Whisper's frontend/backend ports bound to `127.0.0.1` only (e.g. `127.0.0.1:3101:3000`), not `0.0.0.0`. (Note: `wireservice-dev-frontend-1`/`-api-1` currently publish on `0.0.0.0`, which is directly reachable from the internet bypassing nginx/TLS entirely — don't repeat that; bind loopback-only like the Oracle/Elasticsearch containers already do.)
- Avoid host port collisions with Silent Lattice services. The existing stack already uses `3000`/`3001`/`8000`/`8001` for frontend/API, plus Oracle, Elasticsearch, and Ollama ports.
- DNS: `whisper.silentlattice.dev` needs an A record (in GoDaddy, or wherever `silentlattice.dev`'s DNS is actually managed) pointing at the same public IP as the other two subdomains.
- TLS: provision the cert using the `webroot` method (an ACME-challenge `location` block served by the already-running nginx) rather than `certbot certonly --standalone`. All three domains now live behind one nginx; `--standalone` requires briefly stopping nginx to free port 80 for *every* renewal, and adding a third `--standalone` cert means that shared downtime window now happens for three certs instead of two. `webroot` lets certbot renew without ever stopping nginx — worth converting the existing two domains to it as well while making this change, so renewals stop causing any outage at all.
- Nginx: add a port-80→443 redirect block (with the `webroot`/ACME challenge location) and a port-443 `ssl` block with `server_name whisper.silentlattice.dev;`, proxying `/` to `host.docker.internal:<frontend-port>` and `/api/` to `host.docker.internal:<backend-port>`, mirroring the existing `dev.silentlattice.dev` block's structure.
- WebSocket proxying is new: neither existing server block proxies WebSocket upgrades (Silent Lattice doesn't use them). The `/ws` location needs `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, and `proxy_set_header Connection "upgrade";` added explicitly — there's nothing to copy from the existing config for this part.
- `sl-admin.py`'s nginx-provisioning wizard (`_write_nginx_conf`) is hardcoded to exactly two domains (prod + dev). Adding `whisper.silentlattice.dev` means either hand-editing `nginx.conf` directly (a deliberate, documented operational change — see Phase 5) or extending `sl-admin.py` to accept a third domain. Do not assume the existing wizard already supports this.
- Because Silent Whisper owns its whole origin, no path-prefix or base-path configurability (`/silent-whisper/...`) is needed anywhere in the app. `VITE_API_URL` points at `https://whisper.silentlattice.dev/api` and `VITE_WS_URL` at `wss://whisper.silentlattice.dev/ws`, the same pattern Silent Lattice already uses for its own `VITE_API_URL`.
- Provide a plain `/health` backend endpoint — no path-prefix collision risk since it's on its own hostname.

### Local Configuration

Use environment variables for all local service connections:

```text
PGHOST
PGPORT
PGUSER
PGPASSWORD
PGDATABASE
JWT_SECRET
VITE_API_URL          # https://whisper.silentlattice.dev/api in prod, http://localhost:<port>/api in local dev
VITE_WS_URL           # wss://whisper.silentlattice.dev/ws in prod, ws://localhost:<port>/ws in local dev
```

No base-path variables are needed — Silent Whisper is served on its own subdomain and owns `/`, `/api`, and `/ws` outright (see Serving Under Silent Lattice, above).

Server time is authoritative for timestamps, presence state, message creation, and audit records. The frontend must never provide trusted timestamps.

### Configurable LLM Provider Settings

The AI integration must be configurable after initial deployment. Do not hard-code a single vLLM URL, model name, prompt format, or timeout in application code.

Treat `vllm`, `ollama`, and `disabled` as three equally first-class values for `LLM_PROVIDER`, not "vLLM now, maybe Ollama someday." This test environment has no GPU; the target production network this eventually moves to has vLLM backed by dedicated GPU hardware. Moving between them must be a config change only:

- Define one provider-adapter interface (send prompt, receive completion, report health) that both the vLLM adapter and the Ollama adapter implement identically. AI proxy code above that line must never branch on which provider is active except inside the adapter factory that picks one from `LLM_PROVIDER`.
- **This host/test environment**: default to `LLM_PROVIDER=ollama`, running a dedicated Ollama container for Silent Whisper (isolated from Silent Lattice's own two Ollama instances, so restarting/upgrading one doesn't affect the other). This host has no GPU and 8 CPU cores; Silent Lattice's existing Ollama containers already prove CPU-only Ollama inference works fine here for occasional use — vLLM's CPU backend is comparatively unproven and likely to underperform without a GPU.
- **Target production network**: `LLM_PROVIDER=vllm` with `LLM_BASE_URL` pointed at the GPU-backed vLLM endpoint. No code change required — only environment/config.
- On startup and periodically thereafter, the backend health-checks the configured provider and surfaces reachability (up/down, last check time) through the admin settings surface, so a misconfigured or unreachable provider is visibly diagnosable rather than a silent failure the first time someone clicks "Summarize."
- Bound the number of concurrent in-flight LLM requests via `LLM_MAX_CONCURRENT_REQUESTS`, enforced by the AI proxy regardless of provider. This is a hardware-capacity control, not just an abuse control (see Rate Limiting & Abuse Prevention): a CPU-only single Ollama instance can realistically serve close to one generation at a time before requests queue up for tens of seconds each, so default this low (e.g., `1`–`2`) for the Ollama-backed test environment and raise it once running against GPU-backed vLLM, which can sustain meaningfully more concurrency.

Backend configuration must support:

```text
LLM_PROVIDER                  # ollama for this test environment; vllm once moved to the GPU-backed network; disabled to turn AI features off entirely
LLM_BASE_URL                  # e.g. http://silent-whisper-ollama:11434 here, or http://vllm:8000 / http://host.docker.internal:8002 on the target network
LLM_MODEL                     # model identifier sent to the provider (e.g. mistral to match Silent Lattice's existing Ollama models)
LLM_API_KEY                   # optional secret for protected local gateways
LLM_TIMEOUT_MS
LLM_MAX_INPUT_CHARS
LLM_MAX_OUTPUT_TOKENS
LLM_MAX_CONCURRENT_REQUESTS   # caps in-flight LLM proxy calls; low default for CPU-bound Ollama, higher once on GPU-backed vLLM
LLM_TEMPERATURE
LLM_STREAMING_ENABLED
LLM_SUMMARY_PROMPT_VERSION
LLM_TASK_PROMPT_VERSION
```

Provide an admin-only settings surface or config file workflow that can update non-secret LLM options later without code changes. Secrets must remain in environment variables or a local secret store, not in frontend code or committed files.

## 3. Security Baseline

Security is designed in from Phase 1, not bolted on during hardening in Phase 5. The items below are minimums given Silent Whisper handles authentication, private conversations, and an audit trail — treat every one as a Phase 1/2/3 requirement, not a Phase 5 nice-to-have. The Phased Implementation Roadmap below places each item in the phase where it must first be implemented.

### Authentication & Session Security

- Hash passwords with `bcryptjs` using a work factor of at least 12; do not lower this for performance without re-evaluating the threat model. Always call the async API (`bcrypt.hash`/`bcrypt.compare`, not a sync variant) — a work-factor-12 hash blocks the event loop for ~200-300ms, and that same event loop is broadcasting to every connected WebSocket client. Async bcrypt runs on libuv's threadpool instead; be aware it shares that threadpool with other Node internals, so a burst of concurrent signups can still cause minor contention — not a concern at this scale, but don't add more threadpool-heavy work without checking `UV_THREADPOOL_SIZE`.
- Enforce a minimum password length and reject a small deny-list of common/breached passwords at signup, rather than relying on complexity rules alone.
- Issue short-lived JWT access tokens (e.g., 15 minutes) plus a longer-lived refresh token. Store refresh tokens hashed in a `refresh_tokens` table (see PostgreSQL Schema) so they can be revoked on logout, admin action, or detected compromise.
- Store the access token in memory (JS variable/React state) and the refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to the app's base path. Do not store tokens in `localStorage` or `sessionStorage` — either turns a single XSS bug into full account takeover.
- Rate-limit login and signup endpoints per IP and per username to slow credential-stuffing and brute-force attempts. An in-process token-bucket limiter is sufficient at the single-instance, 100-user scale targeted here (see Scalability Target); a shared store (Redis) would only be required if the backend ever runs multiple instances.
- Every failed login attempt is an audit event (see Forensic Security Audit Log). The raw events must exist from Phase 2 even before any alerting is layered on top.

### WebSocket Authentication Handshake

- The browser `WebSocket` constructor cannot send custom headers, so the in-memory access token (which never touches `localStorage`) cannot ride an `Authorization` header on the initial handshake the way REST calls do. Resolve this explicitly rather than improvising per-feature:
  - **Preferred**: open the socket unauthenticated, then immediately emit a client→server `authenticate` event frame carrying the access token as the first message on the open connection. The server holds the connection in an unauthenticated state — no room joins, no data streamed — until that frame validates, then treats the connection as identified for its lifetime.
  - **Acceptable fallback**: pass the token as a handshake query parameter (`/ws?token=...`) only if the `authenticate`-frame approach is impractical for the chosen WebSocket library. If used, ensure nginx and any backend request logging redact the `token` query parameter, since query strings are otherwise logged in plaintext and can leak via `Referer` headers — this is strictly worse for token exposure than the frame-based approach, so treat it as a fallback, not a default.
  - Either way, re-run the same authentication step on reconnect; a reconnecting socket is unauthenticated until it proves otherwise again.
- **Long-lived connections outlive the access token.** A chat WebSocket routinely stays open for hours, but the access token used to authenticate it expires in ~15 minutes (Authentication & Session Security, above). Resolve this explicitly rather than leaving the socket trusting an expired credential indefinitely:
  - The client re-sends a fresh `authenticate` frame with a renewed access token (obtained silently via the refresh-token flow) on a timer well before the current token expires (e.g., every 10 minutes for a 15-minute token).
  - The server tracks each connection's token expiry and disconnects (forcing a reconnect, which re-authenticates) if no renewed `authenticate` frame arrives before it. This keeps the "short-lived access token" property meaningful for WebSocket sessions, not just REST calls.

### Audit Log Write Serialization

- The `prev_row_hash`/`curr_row_hash` chain (Section 4) requires that row N's write read row N-1's hash. At 100 concurrent users, two events (e.g., two failed logins, or two AI audit events) can fire in the same millisecond; if two concurrent writers both read the same "latest row" and then both insert, the chain forks and verification breaks.
- Serialize the read-latest-hash-then-insert step with a Postgres advisory lock (`pg_advisory_xact_lock` on a fixed, well-known key, held for the duration of the transaction that reads the last row and inserts the new one). This is the primary correctness guarantee — it holds regardless of how many backend processes are running, which matters because an in-process-only mutex silently breaks the instant a rolling/blue-green deploy briefly runs an old and new container at the same time. An in-process queue in front of the advisory lock is fine as an optimization (avoids most writers ever contending on the lock) but must not be the only guard.
- Do not rely on "insert and hope" or on database default isolation to prevent this. The advisory lock approach means the audit write path staying single-instance (Scalability Target) is no longer a correctness requirement for the audit chain specifically — it remains a requirement for presence state and rate limiting, which are not lock-protected the same way.

### Authorization Model

- Authorization is enforced server-side on every REST call and every WebSocket event — never inferred from what the UI happens to render. A user who is not a member of a channel must get a 403 (REST) or a closed connection (WebSocket) even if they know its UUID.
- Centralize membership checks (workspace membership, channel membership) in one shared backend module used by both REST handlers and WebSocket event handlers, so the rule is written once and cannot drift between the two transports.
- Private channels, direct messages, and group DMs must never be joinable, listable, or readable by non-members, including via search or admin tooling. The admin audit dashboard is the one intentional exception, and that exception is itself an audited action.
- WebSocket room joins re-validate membership at join time and again on every reconnect — do not trust a previously-granted room membership across reconnects.

### Input Handling & Injection Prevention

- Treat all message content, workspace names, and channel names as untrusted. Use parameterized queries everywhere via Knex.js (Phase 1), which parameterizes by construction; never build SQL with raw string interpolation, including inside `knex.raw()` calls (use its bound-parameter form there too).
- The frontend escapes/sanitizes message content before rendering. React's default JSX escaping covers plain text; if Markdown or rich-text rendering is added later, sanitize with an allow-list HTML sanitizer rather than passing raw content to `dangerouslySetInnerHTML`.
- Enforce a maximum message length server-side (not just in the UI) to bound storage, audit payload size, and LLM prompt size.
- Validate all UUIDs, enum-like fields (`channels.type`, `system_role`), and pagination parameters server-side; reject malformed input with 400s rather than passing it through to the database.

### Transport & Headers

- All traffic terminates TLS at the shared `wireservice-nginx-1` proxy; the backend does not implement TLS itself, but must correctly honor `X-Forwarded-Proto`/`X-Forwarded-For` when computing audit `actor_ip` values and any absolute URLs.
- Set standard security headers at the app layer (or confirm the `whisper.silentlattice.dev` nginx block sets them): a `Content-Security-Policy` with no `unsafe-inline` scripts and no third-party origins (consistent with the offline-only requirement), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`.
- Configure CORS narrowly to `https://whisper.silentlattice.dev` only (plus a local dev origin such as `http://localhost:5173` in non-prod config) — never a wildcard origin, especially once cookies carry credentials. Since Silent Whisper owns its whole subdomain, this is a single fixed origin, not a set of path-prefixed exceptions.

### Rate Limiting & Abuse Prevention

- Rate-limit message sends per user/connection so a single client cannot flood a channel or overwhelm WebSocket broadcast fan-out.
- Rate-limit AI proxy calls (summarize, extract tasks) per user. Local LLM inference is comparatively expensive, and an unbounded loop from a buggy or malicious client could starve the shared provider for every user on the host.
- Enforce `LLM_MAX_CONCURRENT_REQUESTS` as a global cap on in-flight AI proxy calls, independent of the per-user rate limit above — on the CPU-only Ollama-backed test environment, total inference throughput (not just any single user's request rate) is the actual bottleneck.
- Cap concurrent WebSocket connections per user (a small fixed number of tabs/devices) to bound per-user resource use.

### LLM-Specific Risks

- Message content sent into summarization or task-extraction prompts is untrusted user input. Delimit it clearly from system/instruction text in the prompt template (fenced or tagged blocks) so injected instructions inside a message ("ignore previous instructions and...") are treated as data, not as commands to the model.
- Truncate input to `LLM_MAX_INPUT_CHARS` server-side before prompt construction, not just as a UI hint.
- Treat model output as untrusted when rendering it in the UI — apply the same escaping rules as message content, since a prompt-injected response could otherwise attempt stored XSS via the summary text.
- Log the prompt template version and truncated input length (not full content) in the AI audit event so injection attempts remain traceable after the fact.

### Secrets & Configuration

- Zero hardcoding: no API key, password, token, database credential, or secret value is ever written into application code, tests, config committed to the repo, or documentation — including example snippets in `CLAUDE.md`/runbooks, which must use placeholders.
- `JWT_SECRET`, `LLM_API_KEY`, and `PGPASSWORD` live only in environment variables or a local secret store — never in `app_settings`, frontend code, or committed files.
- Load all environment-varying configuration (all of Local Configuration and Configurable LLM Provider Settings, above) dynamically via environment variables, using `dotenv` for local development in both `/frontend` (Vite's built-in `.env` handling) and `/backend`.
- Commit a `.env.example` at the root of `/backend` and `/frontend` with every variable name the app reads and a placeholder value (e.g., `JWT_SECRET=your_jwt_secret_here`, `PGPASSWORD=your_db_password_here`) — never a real value. This is the only environment-variable file ever committed; real `.env`/`.env.local` files are created locally by whoever runs the app and are never checked in.
- A `.gitignore` excluding `.env`, `.env.local`, and any cloud-credential directories (e.g. `.aws/`) must exist before the first commit to the Silent Whisper repo — create it in the same commit that initializes the monorepo structure (Phase 1), not after code already exists.
- If CI/CD (GitHub Actions) or infrastructure-as-code is added later, reference secrets only as repository secrets (`secrets.*` in Actions) or cloud secret-manager identifiers — never embed raw values in workflow YAML or IaC templates.
- Design JWT verification so a `JWT_SECRET` rotation invalidates outstanding tokens predictably (e.g., a key ID embedded in the token header) rather than requiring a hard cutover that silently logs everyone out.

### Dependency Hygiene

- Run `npm audit` (or equivalent) for both `/frontend` and `/backend` before each commit that changes dependencies. Do not add a dependency with a known critical vulnerability without a documented reason.

## 4. PostgreSQL Schema

### Users And Security

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE workspace_members (
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    system_role VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
```

`system_role` supports:

- `ADMIN`
- `MEMBER`

`refresh_tokens` stores only a hash of the token (never the raw value), so revocation (logout, admin action, detected compromise) is a row update, not a secret-recovery risk.

### Layout And Structural Hierarchy

```sql
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE channel_members (
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user ON channel_members(user_id);
```

`channels.type` supports:

- `PUBLIC`
- `PRIVATE`
- `DIRECT`
- `GROUP_DM`

The `idx_channel_members_user` and `idx_workspace_members_user` indexes exist specifically to keep per-request authorization checks (Section 3) fast as message volume and membership counts grow toward the 100-concurrent-user target.

### Communication And Content

```sql
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    parent_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_channel_date ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_threading ON messages(parent_message_id)
    WHERE parent_message_id IS NOT NULL;
```

Messages with `parent_message_id IS NULL` belong to the main channel feed. Messages with `parent_message_id` set belong to a thread attached to the referenced message. Enforce the maximum message length (Section 3) at the API layer before insert.

### Forensic Security Audit Log

```sql
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    actor_id UUID NOT NULL,
    actor_ip VARCHAR(45) NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    target_resource VARCHAR(255),
    payload JSONB,
    prev_row_hash VARCHAR(64) NOT NULL,
    curr_row_hash VARCHAR(64) NOT NULL
);

CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
```

`audit_logs` is append-only. Every inserted row must compute `curr_row_hash` with SHA-256 using the row's canonical audit payload plus the previous row's `curr_row_hash`.

Tracked audit events include:

- Authentication logins
- Authentication failures
- User role changes
- Workspace access changes
- Channel membership changes
- AI summarization requests
- AI action item extraction requests
- Data export requests
- Admin audit verification attempts
- Admin access to private channel/DM content via the audit dashboard exemption (Section 3)

### Runtime Configuration

Store non-secret application settings in the database so operational values can change after deployment without code edits or frontend rebuilds.

```sql
CREATE TABLE app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

Required LLM setting keys:

- `llm.provider`
- `llm.base_url`
- `llm.model`
- `llm.timeout_ms`
- `llm.max_input_chars`
- `llm.max_output_tokens`
- `llm.max_concurrent_requests`
- `llm.temperature`
- `llm.streaming_enabled`
- `llm.summary_prompt_version`
- `llm.task_prompt_version`

Do not store API keys, bearer tokens, or other LLM secrets in `app_settings`. Secret values must come from environment variables or a local secret store.

## 5. Database Access Rights

Runtime application access for standard messaging tables:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
ON users, workspace_members, workspaces, channels, channel_members, messages, refresh_tokens, app_settings
TO app_runtime_user;
```

Append-only access for the audit trail:

```sql
GRANT SELECT, INSERT ON audit_logs TO app_runtime_user;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO app_runtime_user;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_runtime_user;
```

The application must expose no code path that updates, deletes, truncates, or rewrites audit records.

## 6. Feature Requirements

### Core Messaging Utilities

- Users can create project-based workspaces.
- Users can create public and private channels within workspaces.
- Users can create 1-to-1 direct messages.
- Users can create ad-hoc 1-to-many group direct messages.
- Users can click Reply in Thread on any main message to open a sidebar thread.
- Thread replies are stored as messages using `parent_message_id`.
- Message history APIs support paginated loading by channel and timestamp.
- WebSocket updates deliver new messages and thread replies in real time.

### Presence Engine

- The backend tracks active WebSocket connections and server-side heartbeats.
- Presence states include Online and Away.
- Presence status is derived from server-observed connection and heartbeat activity.
- The UI displays presence badges without trusting browser-generated timestamps.

### Immutable Local Auditing

- A backend audit service is the only application path for inserting audit rows.
- Each audit row stores `prev_row_hash` and `curr_row_hash`.
- The first audit row uses a fixed genesis previous hash value documented in code.
- An admin-only dashboard displays recent audit events.
- A verification script walks the audit log in order, recomputes each row hash, and reports either `Log Integrity Verified` or the first row that fails validation.

### Configurable Local LLM AI Features

- The backend communicates with the configured local LLM provider through `LLM_BASE_URL`.
- Ollama is the default provider for this test environment (no GPU on this host); vLLM is the target provider once deployed to the production network with GPU resources. Both implement the same provider-adapter interface (Configurable LLM Provider Settings, above) so switching is a config change, not a code change.
- The frontend never calls the LLM service directly.
- Admins can inspect the active provider, model, timeout, token limits, streaming support, and prompt versions.
- Admins can update non-secret LLM settings later without rebuilding the frontend.
- A Summarize Channel action collects recent unread message strings and sends them to the backend AI proxy.
- The backend formats a summarization prompt and returns a structured text summary.
- An Extract Tasks action parses a selected thread and returns a checklist of clear action items.
- AI requests and outputs must be audited, rate-limited, and prompt-injection-resistant per Section 3.

## 7. Design System & UI/UX Guidelines

Silent Whisper is a companion app to Silent Lattice and should feel like part of the same product family, not a visually distinct tool. Reuse the visual language already established in `~/wireservice-dev/frontend` rather than inventing a new one.

### Apple Human Interface Guidelines Alignment

- System font stack first: `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`, matching Silent Lattice's `global.css` and every component in that codebase — inherit native platform type rendering rather than shipping a webfont.
- Support both light and dark appearance via `prefers-color-scheme`, with an explicit `data-theme` attribute able to override the system preference in either direction. (Note: Silent Lattice's own `global.css` only implements the manual `data-theme` toggle, with no `prefers-color-scheme` media query at all — verified while implementing Phase 1. Silent Whisper's `global.css` adds the media-query layer on top of the same token values, since automatic OS-preference support is what this line actually requires; it reuses the color tokens, not that particular gap.) Never ship a light-only or dark-only UI.
- Minimum 44×44pt hit targets for tappable controls (buttons, channel rows, presence badges used as controls). This is desktop-first, but it's the HIG baseline and keeps the UI usable on touch trackpads and tablets.
- Clear, single-purpose navigation hierarchy: the 3-column layout (workspaces/channels → main feed → thread/admin panel) should read as a strict left-to-right drill-down.
- Respect `prefers-reduced-motion` for any transition or animation (message send, thread open, presence change).
- Maintain WCAG AA contrast minimums for text and interactive states in both themes; specifically verify that the neumorphic light-mode shadows (below) don't reduce perceived contrast on small text.
- Use standard, recognizable controls for core actions (send, reply, mute, leave channel) rather than custom gestures or nonstandard widgets.

### Visual Language (from `~/wireservice-dev/frontend/src/global.css`)

Reuse this token system directly rather than redefining equivalent tokens under different names:

- **Color tokens** as CSS custom properties under `:root, [data-theme="light"]` and `[data-theme="dark"]`: `--surface`, `--surface-alt`, `--card-bg`, `--card-border`, `--card-shadow`, `--border`, `--border-strong`, `--text-1` through `--text-4`, `--item-hover`, `--item-active-bg` / `--item-active-fg`, `--error-*`, `--success-*`.
- **Brand accent**: British Racing Green (`--brg: #00563f` light / `#2da677` dark) drives active states, focus rings, and success states. Reuse the same accent in Silent Whisper so the two apps read as one product family when served side by side under the same nginx host — do not introduce a second accent color.
- **Light mode is soft/neumorphic**: dual-direction shadows (`--card-shadow`, `--input-shadow`) simulate raised/inset surfaces. **Dark mode is flat**: shadows are removed and replaced with hairline borders (`--card-border`, `--border`). Carry this same light/dark split into Silent Whisper's channel list, message cards, and input fields — don't use shadows in both modes.
- **Typography scale**: `--text-xs` (11px) through `--text-3xl` (34px) as already defined. Pick from this scale rather than ad hoc pixel values.
- **Interaction utility classes**: reuse the `.sl-row` / `.sl-card` hover pattern (`background: var(--item-hover)`, 0.1s transition) for channel rows, message rows, and thread list items.
- **Focus rings**: `outline: 1.5px solid var(--brg)` with `1px` offset on all focusable form controls, matching the existing input/select focus style.
- **Scrollbars**: thin (4px), themed via `::-webkit-scrollbar`, matching the existing rules.
- **Accessibility utility**: reuse the `.sl-skip-link` pattern so keyboard users can jump past the 3-column chrome directly into the main message feed.
- **Modals/panels**: `border-radius: 16px` on overlay panels, consistent with every modal in the existing frontend (`ResolutionQueue`, `EntitySearch`, `EnvironmentPanel`, etc.).
- Copy `global.css`'s token block as the literal starting point for Silent Whisper's own `global.css` rather than re-deriving equivalent values by eye, so a future palette change can be applied to both apps consistently.

### Layout

- Mirror the existing 3-column shell pattern already used for Silent Lattice's `NavSidebar` + main content + side panel — Silent Whisper's own left/middle/right layout (Section 2) is structurally the same shape. Reuse spacing and breakpoint decisions rather than reinventing them.

## 8. Phased Implementation Roadmap

### Phase 1: Local Foundation And Database Setup

- Create the monorepo structure with `/frontend`, `/backend`, `/database`, and `/scripts`.
- In the same commit: add a root `.gitignore` excluding `.env`, `.env.local`, and any cloud-credential directories, and add `.env.example` files (with placeholder values only) for `/frontend` and `/backend`. No other code is committed before this exists (Security Baseline: Secrets & Configuration).
- Initialize Vite + React in `/frontend`.
- Copy `~/wireservice-dev/frontend/src/global.css`'s design tokens as the starting point for Silent Whisper's `global.css` (Section 7).
- Initialize the Node.js backend in `/backend`.
- Add Dockerfiles and Compose examples that can run standalone or attach to the existing `wireservice` nginx network.
- Add PostgreSQL migration files for the schema and grants, including `refresh_tokens` and the membership indexes.
- Configure local Postgres connection variables and a connection pool sized per the Scalability Target.
- Configure `VITE_API_URL`/`VITE_WS_URL` so the app runs against `localhost` in development and `whisper.silentlattice.dev` behind the main server proxy — no base-path logic needed since the app owns its whole subdomain.
- Configure baseline security headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`) and a narrow CORS policy for the API.
- Implement the backend audit service for hash-chain insertions, serializing the read-latest-hash-then-insert step with a Postgres advisory lock (`pg_advisory_xact_lock`) so concurrent events can't read the same "latest row" and fork the chain — correct even across an overlapping deploy, not just within one process (Section 3).
- Add tests for audit hash generation, append-only behavior, and concurrent-write ordering (fire overlapping audit events, including from two separate connections/simulated processes, and confirm the chain stays linear).
- Add a Postgres healthcheck (`pg_isready`) to the database container/service and gate the backend's startup on `depends_on: condition: service_healthy`. The backend should still retry/backoff its own initial connection independently of compose ordering, since `service_healthy` alone doesn't guarantee the DB is ready to accept the exact user/database the app needs.
- Pick one query builder and one migration tool now, in Phase 1, so later phases don't each invent their own: Knex.js (`knex` + `pg` driver) for both — parameterized query building by construction (Input Handling & Injection Prevention, Section 3) and a built-in migration/seed system, so there's a single tool to install rather than a query layer plus a separate migration library. Drop to `knex.raw()` with bound parameters for the advisory-lock transaction and any hash-chain SQL that needs it.

### Phase 2: Local Auth And API Base

- Implement username/password signup with a minimum password length and a common-password deny-list.
- Hash passwords locally with `bcryptjs`'s async API (work factor ≥ 12).
- Implement login and failed-login audit events.
- Issue short-lived JWTs signed with `JWT_SECRET`, plus refresh tokens stored hashed in `refresh_tokens`.
- Store the refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie; keep the access token in memory on the frontend (never `localStorage`/`sessionStorage`).
- Apply per-IP/per-username rate limiting to login and signup endpoints.
- Build the shared, centralized authorization module (workspace/channel membership checks) that both REST and WebSocket handlers will call — build it once, here, not per-feature later.
- Build REST endpoints for workspaces, channels, membership, and message history pagination, all going through the shared authorization module.
- Enforce server-side message length limits and input validation on all endpoints.
- Add tests for auth, token revocation, authorization checks (including negative cases — non-members denied), and message pagination.

### Phase 3: Real-Time WebSockets And Layout UI

- Implement WebSocket authentication using the issued JWT via the `authenticate` event-frame handshake (Section 3); hold new connections unauthenticated — no room joins, no data — until that frame validates.
- Make the WebSocket path configurable for reverse-proxy deployment.
- Join users to workspace, channel, direct message, and thread rooms using the same shared authorization module from Phase 2; re-validate membership on every reconnect, not just first join.
- Broadcast message and thread updates only to authorized connected clients.
- Rate-limit message sends per user/connection and cap concurrent WebSocket connections per user.
- Track heartbeat state for presence.
- Build the React 3-column layout per Section 7's design system and HIG guidelines:
  - left: workspaces and channels
  - middle: main chat screen
  - right: thread sidebar or admin tool
- Implement optimistic message rendering with server reconciliation.
- Add tests for WebSocket authorization (including reconnect and non-member cases), message delivery, rate limiting, and presence transitions.

### Phase 4: Configurable Local LLM Integration

- Create a backend AI provider proxy that sends sanitized, delimited prompt payloads to the configured local provider (Section 3's LLM-specific risk mitigations), built against the shared provider-adapter interface.
- Implement the Ollama adapter first (this test environment's default) and the vLLM adapter alongside it — both conforming to the same interface, selected via `LLM_PROVIDER`. Stand up a dedicated Ollama container for Silent Whisper (e.g. `mistral`, matching the model already proven on Silent Lattice's Ollama instances on this host) rather than sharing Silent Lattice's.
- Truncate input to `LLM_MAX_INPUT_CHARS` server-side before prompt construction.
- Rate-limit AI proxy calls per user, and enforce `LLM_MAX_CONCURRENT_REQUESTS` as a global in-flight cap (default low, e.g. 1–2, for the CPU-only Ollama environment).
- Add the periodic provider health-check and surface it in the admin settings view.
- Store non-secret provider settings in a database table or local config file that can be changed after deployment.
- Read provider secrets from environment variables only.
- Implement channel catch-up summarization.
- Implement thread action item extraction.
- Escape/sanitize LLM output before rendering, same as user message content.
- Render streamed or incremental AI text in the frontend when supported by the backend route.
- Audit all AI operations, including prompt template version and truncated input length.
- Add tests for prompt construction/delimiting, authorization, rate limiting, the concurrency cap, provider configuration and health-check reporting, both adapters' error handling, disabled-provider behavior, and audit coverage.

### Phase 5: Verification And Hardening

- Build the admin-only audit dashboard, itself an audited action when it accesses private channel/DM content.
- Add the audit verification script in `/scripts`.
- Add virtual scrolling for long chat histories.
- Add nginx documentation for the `whisper.silentlattice.dev` server block: the DNS A record, the `webroot`-issued cert (and whether the other two domains were converted from `--standalone` to `webroot` at the same time), the new server blocks in `/root/wireservice/nginx/nginx.conf` (redirect + ssl, `host.docker.internal` proxy targets, WebSocket upgrade headers on `/ws`), and whether `sl-admin.py` was extended to manage the third domain or the config was hand-edited.
- Document that prod Compose/nginx changes for the main server are operational changes and must be applied deliberately, because Silent Lattice keeps prod `docker-compose.yml` and nginx behavior separate from normal app-code promotion.
- Conduct an authorization audit pass across private channels, direct messages, group DMs, admin views, and AI actions to confirm no gaps remain from Phases 2–4 (this is a verification pass, not the first implementation of these checks).
- Load-test at 100 concurrent simulated users; record p95 message-delivery latency and API response times against the Scalability Target.
- Run `npm audit` across `/frontend` and `/backend` and resolve or document any critical findings.
- Conduct a manual HIG/accessibility pass: tap target sizes, contrast in both themes, reduced-motion behavior, keyboard navigation, and skip-link behavior.
- Add integration tests for key user workflows.
- Document offline run commands in `CLAUDE.md` or an equivalent system summary file.

## 9. Rules Of Engagement For AI Agents

- Do not write code that fetches assets over the internet.
- Do not use external CDNs.
- Do not rely on browser time for trusted timestamps.
- Use server-generated timestamps for messages, presence, and audit records.
- Enforce authorization server-side for every REST request and WebSocket event; never rely on the UI to hide something a user isn't authorized to see.
- Never store auth tokens in `localStorage` or `sessionStorage`; refresh tokens go in `httpOnly` cookies, access tokens stay in memory.
- Treat all user-generated content — messages, channel/workspace names, and LLM output — as untrusted when rendering; escape or sanitize before display.
- Delimit user content from instructions in any LLM prompt template so message content cannot be interpreted as commands to the model.
- Apply rate limits to authentication, message-send, and AI proxy endpoints; do not defer this to a later phase.
- Write tests alongside each backend module, frontend feature, and script, including negative authorization tests (non-member denied).
- Keep audit log writes centralized in the backend audit service.
- Do not create application code paths that mutate audit rows.
- Keep LLM provider access server-side only.
- Do not hard-code deployment paths, public URLs, LLM endpoints, model names, or host ports.
- Never hardcode API keys, passwords, tokens, or database credentials anywhere — code, tests, or docs. Load all such values from environment variables (`dotenv` locally); the only environment-variable file ever committed is `.env.example`, populated with placeholders.
- If a `.gitignore` excluding `.env`/`.env.local`/credential directories doesn't already exist when starting work in this repo, create it before writing any other code.
- Preserve compatibility with the existing Silent Lattice server topology when adding nginx, Compose, or environment configuration.
- Reuse the design tokens, component conventions, and interaction patterns from `~/wireservice-dev/frontend/src/global.css` instead of introducing new colors, fonts, spacing values, or accent colors.
- Follow Apple HIG minimums (44pt tap targets, reduced-motion support, AA contrast, light/dark parity) for all new UI.
- Maintain local run documentation for fully offline operation.

## 10. Acceptance Criteria

- The application can be run locally with PostgreSQL, the backend, the frontend, and a local Ollama instance for AI features.
- Users can authenticate, create workspaces, create channels, send messages, and reply in threads.
- WebSocket clients receive real-time authorized updates; non-members are provably denied access to private channels, DMs, and group DMs (join attempts and API calls, not just UI hiding).
- Presence badges reflect server-observed connection state.
- Admin users can view audit records; that access is itself audited.
- The audit verification script detects manual audit-log tampering.
- The audit hash chain stays linear and verifiable under concurrent load (two audit events firing in the same millisecond do not fork the chain).
- WebSocket connections are unauthenticated (no room data) until the client's `authenticate` frame validates, on both first connect and reconnect.
- Long-lived WebSocket sessions silently re-authenticate with a renewed access token before the original one expires, and are disconnected (forcing a reconnect) if they don't.
- The audit hash chain remains correct under concurrent writers from separate processes/connections, not just within a single process (verifies the Postgres advisory lock, not just an in-process queue).
- AI channel summaries and thread task extraction work through the configurable backend LLM proxy, with input truncation, prompt-injection delimiting, output sanitization, and a concurrency cap in place.
- LLM provider settings can be changed later without code edits for non-secret values; switching `LLM_PROVIDER` between `ollama`, `vllm`, and `disabled` requires only a config change, never a code change, and the admin settings view reports whether the configured provider is currently reachable.
- Refresh tokens are stored hashed and can be revoked; access tokens are short-lived; no auth token is ever stored in `localStorage`/`sessionStorage`.
- Authentication, message-send, and AI proxy endpoints are rate-limited per user/IP.
- A load test confirms the system serves 100 concurrent simulated users with documented p95 message-delivery and API latency.
- The UI passes a manual Apple HIG/accessibility check (tap targets, contrast, reduced motion, keyboard navigation) in both light and dark themes.
- Silent Whisper's UI uses the same design tokens (colors, type scale, spacing, focus rings, shadow/border treatment) as `~/wireservice-dev/frontend`, so the two apps present as one product family when served together.
- Silent Whisper is served behind the existing shared nginx proxy on its own dedicated hostname, `https://whisper.silentlattice.dev`, with its own TLS cert and WebSocket-upgrade-aware `/ws` route.
- The project remains usable without public internet access after dependencies and local services are prepared.

## 11. Implementation Log

Every implemented element is logged here as it lands, per-phase, with the files touched and what was actually verified (not just written) — so this section is a record of what's real, not a restatement of the roadmap above.

### Phase 1: Local Foundation And Database Setup — complete (2026-07-12)

- **Monorepo scaffold**: `/frontend`, `/backend`, `/database` (`migrations/`, `seeds/`), `/scripts` created. Root `.gitignore` and `.env.example` already existed from repo setup; extended with the Docker Compose variable set. Added `backend/.env.example` and `frontend/.env.example`.
- **Secrets convention**: root `.env`/`.env.example` hold the Docker Compose variable set (`POSTGRES_*`, `APP_DB_*`, `JWT_SECRET`, `CORS_ORIGIN`, `VITE_*`); `backend/.env.example` and `frontend/.env.example` hold the same variables for anyone running either half directly on the host without Docker. Both are kept in sync manually — documented in RUNBOOK.md.
- **Backend base** (`backend/src/config.js`, `backend/src/db.js`, `backend/src/middleware/security.js`, `backend/src/index.js`): Express app with `helmet`-based CSP/security headers, CORS restricted to `CORS_ORIGIN`, a plain `GET /health` that checks live DB connectivity, and a Knex pool connecting as the least-privilege `APP_DB_USER` role (never the migration/admin credentials). Pool sized `min:2/max:20` per the Scalability Target.
- **Database schema** (`database/migrations/0001`–`0006`): `uuid-ossp` extension, `users`, `workspace_members` (+ `idx_workspace_members_user`), `refresh_tokens` (+ `idx_refresh_tokens_user`), `workspaces`, `channels`, `channel_members` (+ `idx_channel_members_user`), `messages` (+ threading/date indexes), `audit_logs` (+ timestamp/actor indexes), `app_settings` — all matching Section 4 verbatim.
- **Grants migration** (`database/migrations/0007_grants.js`): creates the `app_runtime_user` role (password from `APP_DB_PASSWORD`, never hardcoded) and applies the exact Section 5 GRANT/REVOKE set. Hit and fixed a real bug here: Postgres DDL (`CREATE ROLE`/`ALTER ROLE`) rejects server-side bind parameters for the password literal (`knex.raw('... PASSWORD ?', [pw])` fails with `syntax error at or near "$1"`) — fixed by embedding the password as a dollar-quoted SQL literal instead of a bound parameter, since DDL doesn't support the extended query protocol's parameter substitution the way DML does.
- **Audit service** (`backend/src/audit/auditService.js`): genesis hash (64 zero chars), canonical (sorted-key) JSON payload hashing, and `pg_advisory_xact_lock`-serialized read-latest-then-insert — the DB-level correctness guarantee from Section 3, not an in-process mutex. Verified with a real test suite (`backend/tests/auditService.test.js`, 5 tests, run against the live Postgres container) covering: genesis-row chaining, sequential chain verification by recomputing every hash, **20 concurrent inserts producing an unforked chain** (the actual hazard the advisory lock exists for), rejection of malformed events, and — connecting as `app_runtime_user`, the same role the app itself uses — confirmation that `UPDATE`/`DELETE` against `audit_logs` are rejected with a permission error at the database level, not just absent from the application code.
- **Docker Compose** (`docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`): `postgres` (healthcheck via `pg_isready`, 1GB limit), a profile-gated one-shot `migrate` service, `backend` (`depends_on: postgres: condition: service_healthy`, 512MB limit), `frontend` (Vite dev server, 128MB limit). All ports bound to `127.0.0.1` only. Backend's build context is the repo root (not `/backend`) specifically so the image can also include `/database` — `knexfile.js`'s relative migrations path resolves identically on host and in-container.
- **Frontend scaffold** (`frontend/`): Vite + React, `global.css` copied from `~/wireservice-dev/frontend/src/global.css` per Section 7. Found and fixed a real discrepancy while doing this: the source file has **no** `prefers-color-scheme` media query at all (dark mode there is manual-toggle-only via `[data-theme="dark"]`), contradicting what Section 7 originally claimed ("exactly as Silent Lattice does"). Fixed by adding a `@media (prefers-color-scheme: dark)` block carrying the same dark token values, with `[data-theme]` still able to override in either direction — Section 7's text above has been corrected to describe this accurately. Also added a `prefers-reduced-motion` rule (HIG requirement) not present in the source file. `App.jsx` is a placeholder that calls `/health` end-to-end to prove wiring, styled with the copied tokens — the real 3-column layout is Phase 3.
- **End-to-end validation actually run, not just written**: `docker compose up -d postgres`, ran migrations via `docker compose run --rm migrate`, confirmed all 11 tables + both indexes-per-table + the `app_runtime_user` role exist, confirmed granted privileges match Section 5 exactly (`information_schema.role_table_grants`), ran the full Jest suite against the live DB (5/5 pass), rolled back all 7 migrations and re-applied them cleanly (`down()` functions verified, not just assumed), brought up `backend`+`frontend` containers, confirmed `/health` returns `{"status":"ok","db":"ok"}`, confirmed CORS headers (`Access-Control-Allow-Origin: http://localhost:3101`) and CSP/security headers are actually present on responses, confirmed the frontend serves and its skip-link/title render. Checked real resource usage against the Local Test Environment Resource Envelope: Postgres 27MB/1GB, backend 17MB/512MB, frontend 68MB/128MB — all well under budget.
- **Not yet done**: auth, WebSockets, LLM proxy, the real 3-column UI, and everything else in Phases 2–5 remain as documented in Section 8.
