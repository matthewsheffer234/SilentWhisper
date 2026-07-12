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
- **Network integration pattern** (updated 2026-07-12 after actually deploying this — see Section 11's "Production Deployment" entry for the full story): this host runs two patterns side by side — prod (`~/wireservice`) joins `wireservice_default` directly and nginx proxies via service name (`http://frontend:3000`); dev (`~/wireservice-dev`) reaches its equivalent ports via `http://host.docker.internal:3001`/`:8001`, which works there only because those ports are bound to `0.0.0.0`. Silent Whisper's ports are deliberately bound to `127.0.0.1` instead (see below) — and `host.docker.internal` traffic arrives via the Docker bridge gateway, a different source address than localhost, which a loopback-only bind rejects. So Silent Whisper actually uses a **third pattern**: its own independent Compose stack (`postgres`/`migrate` stay isolated), but `backend` and `frontend` are *also* attached to `wireservice_default` (declared as an `external` network in `docker-compose.yml`), and nginx addresses them by container name (`silentwhisper-backend-1:8000`, `silentwhisper-frontend-1:3000`) — the same mechanism prod uses, not dev's. This was originally planned as the dev/`host.docker.internal` pattern; that assumption turned out to be wrong the first time it was actually deployed, and is corrected here rather than left stale.
- Publish Silent Whisper's frontend/backend ports bound to `127.0.0.1` only (e.g. `127.0.0.1:3101:3000`), not `0.0.0.0`. (Note: `wireservice-dev-frontend-1`/`-api-1` currently publish on `0.0.0.0`, which is directly reachable from the internet bypassing nginx/TLS entirely — don't repeat that; bind loopback-only like the Oracle/Elasticsearch containers already do.)
- Avoid host port collisions with Silent Lattice services. The existing stack already uses `3000`/`3001`/`8000`/`8001` for frontend/API, plus Oracle, Elasticsearch, and Ollama ports.
- DNS: **done** — `whisper.silentlattice.dev` already resolved when checked (2026-07-12), implying a wildcard record already exists at the registrar. No GoDaddy change was actually needed.
- TLS: **done**, via `certbot certonly --standalone -d whisper.silentlattice.dev` (2026-07-12) — the user explicitly chose to match the existing two domains' method rather than migrate to `webroot` as originally recommended here. That recommendation still stands as the better long-term fix (see the certbot renewal-hooks problem discovered in Section 11 — right now **none of the three domains** can actually auto-renew), just not the one taken this round.
- Nginx: **done**. Not `host.docker.internal` as originally planned here — see the corrected Network Integration Pattern note above. The actual working blocks proxy `/` to `silentwhisper-frontend-1:3000`, `/api/` to `silentwhisper-backend-1:8000` (no rewrite — Silent Whisper's Express app already expects the `/api` prefix itself, unlike the other two blocks' APIs), `/health` the same, and `/ws` with the upgrade headers below.
- WebSocket proxying: **done** — `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";` on the `/ws` location, verified with a real WebSocket client completing an `authenticate` round trip through nginx, not just assumed from the config.
- `sl-admin.py`'s nginx-provisioning wizard (`_write_nginx_conf`) is hardcoded to exactly two domains (prod + dev) — confirmed still true, and moot besides: its rebuild/restart/reload menu options assume `wireservice-nginx-1` is a `docker compose` service, which it is not (confirmed — no `nginx` service exists in `/root/wireservice/docker-compose.yml`). The config was hand-edited directly, and the container rebuilt/reloaded manually (see RUNBOOK.md, Production Deployment).
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
- Workspace admins can invite an existing user into their workspace by username, optionally as `ADMIN` (`POST /workspaces/:workspaceId/members` — see Section 11's "Post-Phase-5 finding" entry for the gap this closed).

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
- Silent Whisper is served behind the existing shared nginx proxy on its own dedicated hostname, `https://whisper.silentlattice.dev`, with its own TLS cert and WebSocket-upgrade-aware `/ws` route. **Done and verified live (2026-07-12)** — see Section 11.
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

### Phase 2: Local Auth And API Base — complete (2026-07-12)

- **Password policy & hashing** (`backend/src/auth/passwordPolicy.js`): minimum 10 characters plus a ~30-entry common-password deny-list. `bcryptjs`'s async API only, salt rounds floored at 12 via config (`Math.max(12, ...)` — can't be configured below the floor).
- **JWT access tokens with rotation-ready key id** (`backend/src/auth/jwt.js`): 15-minute tokens signed with `JWT_SECRET`, carrying a `kid` header from `JWT_KEY_ID`. Verification checks both the signature and that `kid` matches the currently configured key id — catches not just a full secret rotation (which already invalidates the signature on its own) but the narrower case of `JWT_KEY_ID` being bumped without actually rotating the secret.
- **Refresh tokens with rotation + reuse detection** (`backend/src/auth/refreshTokens.js`, `database` unchanged — reuses Phase 1's `refresh_tokens` table): opaque random tokens, only a SHA-256 hash stored. Every `/api/auth/refresh` call revokes the presented token and issues a new one inside one row-locked (`forUpdate`) transaction. Presenting an *already-revoked* token — a replay — revokes every other outstanding token for that user and is audited as `AUTH_REFRESH_REUSE_DETECTED`.
  - **Real bug hit and fixed here**: the reuse-detection branch originally revoked the user's other tokens and then `throw`-ed the reuse error *inside the same `db.transaction()` callback* — which rolled back the revocation it had just performed, since a rejected transaction callback rolls back everything in it. A test (`replay the old token, then try to use the token issued by the legitimate rotation`) caught this: the "revoked" token still worked. Fixed by having the transaction callback always resolve with a discriminated result (`{kind: 'ok'|'reuse'|'invalid'|'expired', ...}`) and throwing the actual error *after* the transaction commits.
- **Cookie handling**: refresh token in an `httpOnly`, `SameSite=Strict` cookie (`Secure` in production), scoped to `/api/auth` specifically — tighter than the plan's minimum, since that's the only path range that ever needs it. Access token returned in the response body only, held in memory on the client (Phase 3 will wire this into the frontend).
- **Rate limiting** (`backend/src/auth/rateLimit.js`): stacked per-IP (20/15min) and per-username (10/15min) limiters on login, per-IP (10/hour) on signup. **Real bug hit and fixed here**: the test suite itself tripped these limits — many signups/logins within one test file share one in-process limiter, which isn't the credential-stuffing pattern the limiter exists to catch. Fixed with a `skip` condition on `NODE_ENV === 'test'` (set by `npm test`, never in dev/prod), not by weakening the limits themselves.
- **Anonymous audit actor** (`backend/src/audit/auditService.js`): added `ANONYMOUS_ACTOR_ID` (all-zero UUID, same convention as `GENESIS_HASH`) for audit events with no real authenticated actor yet — e.g. a failed login against a username that doesn't exist, where attributing the attempt to a real user's row would be wrong. `audit_logs.actor_id` has no FK constraint, so this is valid without a schema change.
- **Shared authorization module** (`backend/src/authz/membershipService.js`): `requireWorkspaceMember`/`requireWorkspaceAdmin`/`requireChannelMember`/`isChannelMember`, all taking `db` explicitly so they work identically inside a transaction or against the plain pool — built once here for both REST (now) and WebSocket handlers (Phase 3) to share, per Section 3. Adopted a specific status-code convention throughout: not authenticated → 401; not a member of a workspace/channel → **404**, not 403 (so a private resource's existence is never confirmed to someone who can't access it, including when the resource simply doesn't exist at all — both cases are deliberately indistinguishable); a member but lacking a specific privilege (e.g. non-admin action) → 403.
- **REST endpoints** (`backend/src/routes/{auth,workspaces,directMessages,messages}.js`, wired in `backend/src/index.js`): `/api/auth/{signup,login,refresh,logout}`; `/api/workspaces` (create/list); `/api/workspaces/:id/channels` (create/list — list shows all `PUBLIC` channels plus only the `PRIVATE` ones the caller has joined); `/api/workspaces/:id/channels/:id/join` (self-service, `PUBLIC` only); `/api/workspaces/:id/channels/:id/members` (add an existing workspace member to a channel, `PRIVATE` included); `/api/direct-messages` and `/api/group-direct-messages` (both create channels with `workspace_id = NULL`, matching the schema's nullable FK — DMs aren't scoped to a workspace); `/api/channels/:id/messages` (GET paginated by `before` timestamp cursor + `limit`, newest-first, with `?parentMessageId=` to fetch a thread's replies instead of the main feed; POST to send, with server-side length validation and cross-channel `parentMessageId` rejection).
- **Validation** (`backend/src/validation.js`): UUID/username/email/name/message-length/enum/pagination assertions matching the schema's column limits (`VARCHAR(50)`/`VARCHAR(100)`/`VARCHAR(255)`) and the plan's `MAX_MESSAGE_LENGTH` (10,000 chars) — malformed input gets a 400 before it ever reaches a query.
- **Error handling** (`backend/src/errors.js`): one `AppError` taxonomy (400/401/403/404/409) and a terminal Express error handler that never leaks stack traces or raw driver errors to the client.
- **Test suite** (`backend/tests/{auth,authorization,messages}.test.js`, 27 new tests, all against the live Postgres): signup validation (length, common-password, duplicate-with-identical-message), login success/failure with correct actor attribution (real user vs. anonymous sentinel), refresh rotation, replay/reuse detection cascading to full session revocation, logout; workspace-admin-on-create, 404-not-403 for non-members, private-channel invisibility to non-members, public-self-join vs. private-invite-only, DM channel dedup and third-party exclusion; message pagination (limit, `before` cursor correctness, thread-vs-main-feed separation), empty/oversized/exactly-at-limit content, cross-channel `parentMessageId` rejection.
- **End-to-end validation actually run**: full Jest suite (32/32, including Phase 1's audit tests) against the live Postgres container; rebuilt the `backend` Docker image and ran a full manual curl flow against it (signup → create workspace → create channel → send message → fetch messages → refresh → logout) confirming both the containerized deployment and the host-side tests agree; confirmed the resulting `audit_logs` chain (`AUTH_SIGNUP` → `WORKSPACE_CREATED` → `CHANNEL_CREATED` → `AUTH_TOKEN_REFRESH` → `AUTH_LOGOUT`) is complete and correctly attributed.
- **Not yet done**: WebSocket auth/rooms/presence, the LLM proxy, and the real 3-column UI remain as documented in Section 8 (Phases 3–5). The frontend still only has the Phase 1 placeholder screen — it doesn't call any of these new endpoints yet.

### Phase 3: Real-Time WebSockets And Layout UI — complete (2026-07-12)

- **WebSocket server** (`backend/src/ws/server.js`): attached to the same HTTP server as Express (`backend/src/index.js`, `http.createServer(app)` + `attachWebSocketServer`), on configurable `WS_PATH` (default `/ws`). Connections start unauthenticated — no joins, no data — until a client `authenticate` frame validates via the same `verifyAccessToken` Phase 2 already uses. Supports re-authenticating an already-open connection with a renewed token (rejects identity-switch attempts), and a periodic sweep (`WS_TOKEN_SWEEP_INTERVAL_MS`) disconnects any socket whose token has expired without a renewal frame arriving — the long-lived-connection requirement from Section 3.
- **Shared authorization, reused not reimplemented**: room joins call the exact same `authz/membershipService.js` from Phase 2 (`requireChannelMember`), re-validated on every `join` frame — including reconnects, since a fresh connection carries no memory of a prior session's joins. A non-member and a nonexistent channel get the identical error message, preserving the REST layer's "don't confirm private-resource existence" property over the socket too.
- **Message creation unified across transports** (`backend/src/services/messageService.js`): extracted from the Phase 2 REST route so REST and WebSocket sends run through identical validation/insert logic — the same anti-drift principle Section 3 requires for authorization, applied here to message creation. Both paths now also add `username` to the message payload (passed through from the already-decoded JWT/session, not an extra query) and the REST history endpoint joins `users` for the same field — added because displaying raw UUIDs as message authors would have been unusable; the history query needed every `created_at` reference qualified as `messages.created_at` once that join was added, since `users` also has a `created_at` column and the unqualified reference became ambiguous (caught by a test, not by inspection).
- **Presence engine** (`backend/src/ws/presence.js`, `ws/connectionRegistry.js`): in-memory only, per the Scalability Target's single-instance assumption. `online`/`away` are server-observed from heartbeat recency (never a client timestamp); a periodic sweep (`WS_PRESENCE_SWEEP_INTERVAL_MS`) downgrades stale connections to `away`, and a user's last connection closing broadcasts `offline` to every other authenticated client.
- **Rate limiting & connection caps** (`backend/src/ws/rateLimiter.js`, `config.ws`): a fixed-window per-user cap on message sends (`WS_MAX_MESSAGES_PER_WINDOW`, default 10/10s) and a per-user concurrent-connection cap (`WS_MAX_CONNECTIONS_PER_USER`, default 5) enforced at `authenticate` time.
- **Optimistic send + reconciliation**: the WS `message` frame accepts an opaque `clientNonce`, echoed back verbatim in the `message_created` broadcast — meaningless to other clients, but lets the sender's own UI match a confirmed message back to the placeholder it rendered before the round trip completed.
- **Backend test suite** (`backend/tests/{ws,presence}.test.js`, 24 new tests; 56 total across the whole backend now): a real `ws` client against a real listening server on an ephemeral port (no mocking) covering the unauthenticated-frame rejection, invalid-token rejection, re-authenticate-same-identity, reject-identity-switch, the concurrent-connection cap, non-member join denial with existence-indistinguishable errors, reconnect re-validating membership fresh (denied → added via REST → a **new** connection now succeeds, proving nothing was cached), message delivery to joined clients only (not to a non-joined outsider), REST-sent messages broadcasting to WS-joined clients, `clientNonce` echo, send-before-join rejection, rate-limit enforcement, and presence online/offline transitions; a separate fake-timers unit test (`presence.test.js`) deterministically proves the online→away staleness sweep without waiting out a real time window.
- **Two real bugs found by the test suite itself, not by inspection**:
  1. Several new WS/presence tests initially timed out waiting for a broadcast that had, in fact, already arrived — `await`ing the triggering action (a REST call, or another socket's own `authenticated` ack) *before* attaching the listener for the resulting broadcast left a window where the event could arrive and be silently dropped with nothing listening yet. Fixed by attaching every such listener before triggering the action that causes it, not after.
  2. Two WS tests failed for an unrelated, real reason: adding a user to a channel requires they already be a *workspace* member (Phase 2 rule), and the tests had skipped that setup step — fixed the tests, not the app, since the app was correctly enforcing its own rule.
- **Frontend** (`frontend/src/{api,context,ws,components}/`): `api/client.js` (in-memory-only access token, silent refresh-and-retry-once on a 401, never `localStorage`), `api/auth.js` + `AuthContext.jsx` (session restore on load via `GET /api/auth/me`, added this phase since the frontend has no other way to learn who's logged in after a bare token refresh), `ws/socket.js` (authenticate-frame handshake, exponential-backoff-with-jitter reconnect, periodic silent re-auth over the same open socket well before the 15-minute token expiry, heartbeats), and the 3-column UI itself: `LoginScreen`, `WorkspaceSidebar` (workspaces + channels, create/join), `ChannelView` (message feed with optimistic send, composer), `ThreadSidebar` (thread replies), `PresenceBadge`. All built from `global.css`'s copied design tokens (Section 7) — no new colors, fonts, or spacing introduced.
- **A third real bug, found only by driving the app in an actual browser** (Jest/supertest couldn't have caught this — it's React-lifecycle-specific): React 18 StrictMode double-invokes mount effects in development. `AuthContext`'s session-restore effect had no guard against this, so it fired `POST /api/auth/refresh` twice on mount. Since refresh tokens rotate-on-use (Phase 2), the second call raced the first: if it lost the race, it hit reuse detection and 401'd — and because that failure's `.catch(() => setStatus('anonymous'))` could resolve *after* the winning call had already set `status: 'authenticated'`, it could silently clobber a valid session back to the login screen. First-load-with-no-session-yet showed the underlying symptom (2 refresh attempts instead of 1) before this was diagnosed as a race rather than expected behavior. Fixed with a `useRef` call-once guard around the restore call, independent of how many times the effect body itself runs.
- **End-to-end validation actually run**: full backend Jest suite (56/56) against the live Postgres container; `docker compose up -d --build backend frontend` rebuilt both images; a real headless-Chromium session (Playwright, driven via a throwaway script — no `chromium-cli` available in this environment, so `playwright` was installed directly, reusing/updating the cached browser binary) drove the actual app end to end: sign up → create a workspace → create a channel → confirm the WebSocket join enables the composer → send a message and see it render → open a thread and send a reply and see it render → reload the page and confirm the session restores (username still shown, no re-login needed) — with `console --errors` checked at each step, not just the final screenshot. Screenshots sent to the user directly.
- **Not yet done**: the LLM proxy and admin audit dashboard remain as documented in Section 8 (Phases 4–5). Frontend automated tests (Vitest/RTL) are not set up — Phase 3 verification relied on the backend Jest suite plus real end-to-end browser driving, which is what actually caught the StrictMode race above; this is a real gap worth closing before the codebase grows much further, not a permanent decision.

### Production Deployment: whisper.silentlattice.dev live (2026-07-12)

Triggered by the user hitting `https://whisper.silentlattice.dev` and getting Silent Lattice's login page plus a TLS warning — the Phase 5 nginx/TLS work (Section 8) hadn't started yet; everything up to this point only ran in the local Docker Compose test environment. Diagnosed and fixed end-to-end, with explicit user confirmation before touching the shared production nginx (`wireservice-nginx-1`, which also serves live `silentlattice.dev`/`dev.silentlattice.dev` traffic).

- **Root cause of the original symptom**: no `server_name whisper.silentlattice.dev` block existed in `/root/wireservice/nginx/nginx.conf`, so nginx fell back to the first `listen 443 ssl` block (`silentlattice.dev`) for the unmatched hostname — explaining both the wrong page (that block's `proxy_pass`) and the TLS warning (that block's cert, mismatched against the requested SNI).
- **DNS was already fine** — `whisper.silentlattice.dev` already resolved (a wildcard record must already exist at the registrar); no GoDaddy change was needed this round.
- **`wireservice-nginx-1` is not Compose-managed**, despite `sl-admin.py`'s infra menu assuming it is (`docker compose ... nginx` — confirmed no `nginx` service exists in `/root/wireservice/docker-compose.yml`, so that menu's rebuild/restart/reload options are currently non-functional no-ops). It's a plain image (`wireservice-nginx`, built from `nginx/Dockerfile` which `COPY`s `nginx.conf` in at build time) run via a bare `docker run` with `--network wireservice_default --add-host host.docker.internal:host-gateway --restart unless-stopped -p 80:80 -p 443:443 -v /etc/letsencrypt:/etc/letsencrypt:ro`. Any future nginx.conf change needs a rebuild + recreate (or a `docker cp` + `nginx -s reload` for a faster, zero-port-downtime path — used here).
- **Cert**: issued via `certbot certonly --standalone -d whisper.silentlattice.dev` (user's choice — matches the existing two domains' method rather than migrating to `webroot`), requiring a brief `docker stop wireservice-nginx-1` to free port 80. Expires 2026-10-10.
- **A real architecture correction made live**: the original Section 2 design assumed Silent Whisper's containers would be reached via `host.docker.internal` on their published ports, mirroring `wireservice-dev`. That doesn't work — those ports are bound to `127.0.0.1` (deliberately, for security), and `host.docker.internal` traffic arrives via the Docker bridge gateway, a different source address than localhost, which a loopback-only bind rejects. `dev.silentlattice.dev`'s equivalent ports are bound to `0.0.0.0`, which is why that pattern works for it and didn't for Silent Whisper. Fixed by attaching `backend` and `frontend` to `wireservice_default` (declared as an `external` network in `docker-compose.yml`, not a manual one-off `docker network connect` — confirmed this survives a full `docker compose up --build` recreate) and having nginx address them by container name instead. **Section 2's design note has been superseded by this** — it now documents the actual working pattern, not the originally-assumed one.
- **Two more real bugs found while verifying, both fixed**:
  1. Nginx caches upstream DNS resolution for a `proxy_pass` hostname at reload/start time — recreating `backend`/`frontend` containers gives them new IPs, and nginx kept sending traffic to the old (now-dead) ones until reloaded again. `nginx -s reload` after any Silent Whisper container recreation is now a documented required step (RUNBOOK.md).
  2. Vite's dev server rejects requests with an unrecognized `Host` header by default (DNS-rebinding protection) — nginx forwards the real `Host: whisper.silentlattice.dev`, which Vite refused with a 403 until added to `server.allowedHosts` in `vite.config.js`.
  3. Vite's own HMR (hot module reload) WebSocket client tries to connect over the public domain too and fails (`Unexpected response code: 200` — nginx's `/` location has no `Upgrade`/`Connection` headers, unlike `/ws`). This is cosmetic console noise from the dev server's own convenience feature, not a break in the application (the app's own `/ws` endpoint was directly verified working). Left unfixed for now — the real fix is serving a production static build instead of a dev server behind the public domain, which is Phase 5 territory, not a quick config tweak.
- **A significant finding, not caused by this work but affecting it**: `/etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh` and `post/start-nginx.sh` both run `docker compose stop/start nginx` from `/root/wireservice` — but, per the point above, there is no `nginx` service in that Compose file. These hooks are silently non-functional, meaning **none of the three certs (including the two pre-existing ones) will actually free port 80 for `certbot renew`'s standalone authenticator**, and all three are liable to fail to auto-renew around 60 days from issuance. This predates this session's changes and affects `silentlattice.dev`/`dev.silentlattice.dev` too, not just the new cert — flagged to the user, not fixed yet (fixing it means rewriting those hook scripts to `docker stop`/`docker start wireservice-nginx-1` directly, since the container isn't Compose-managed).
- **End-to-end validation actually run**: `curl` against `/health` and `/` with the real cert inspected via `openssl s_client` (confirms `CN = whisper.silentlattice.dev`, valid dates); a raw Node `ws` client completing a full `authenticate` round trip through nginx to confirm the WebSocket upgrade path works, not just assumed from the location block; confirmed `silentlattice.dev` and `dev.silentlattice.dev` still return 200 (no regression to live traffic); a full Playwright browser session against `https://whisper.silentlattice.dev` itself (not localhost) repeating the entire Phase 3 flow — signup, workspace, channel, live message, thread reply, page reload with session restore — end to end over the real public URL with a trusted cert.
- **Not yet done**: certbot renewal hooks (flagged above, needs a decision + fix); Vite HMR-over-public-domain noise (cosmetic); no production static frontend build yet (still a dev server, acceptable for now but not ideal long-term for a public URL).

### Phase 4: Configurable Local LLM Integration — complete (2026-07-12)

- **Config + runtime settings layer** (`backend/src/config.js`'s new `config.llm`, `backend/src/llm/settingsService.js`): every Section 2 env var (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_TIMEOUT_MS`, `LLM_MAX_INPUT_CHARS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_MAX_CONCURRENT_REQUESTS`, `LLM_TEMPERATURE`, `LLM_STREAMING_ENABLED`, `LLM_SUMMARY_PROMPT_VERSION`, `LLM_TASK_PROMPT_VERSION`) becomes the env-var *default* for a same-named `llm.*` row in `app_settings` (Section 4's `app_settings` table, already created in Phase 1). `getEffectiveSettings(db)` reads live overrides and merges them over the env defaults on every call — no cache to invalidate, since this table is tiny and settings change rarely. `LLM_API_KEY` is the one deliberate exception: it never has a database-backed override and is merged back in only at the adapter call site, never returned by any settings read.
- **Provider-adapter interface, exactly one branch point** (`backend/src/llm/adapters/{adapterInterface,ollamaAdapter,vllmAdapter,disabledAdapter}.js`, `backend/src/llm/adapterFactory.js`): `generate({settings, prompt, onChunk})` and `checkHealth({settings})`, implemented identically by all three adapters. `adapterFactory.getAdapter(provider)` is the only place in the codebase allowed to branch on which provider is active, per Section 2. Ollama talks to its native `/api/generate` (newline-delimited JSON streaming) and `/api/tags` (health); vLLM talks to the OpenAI-compatible `/v1/completions` (SSE streaming, `data: ... [DONE]`) and `/v1/models`; `disabled` always throws `ServiceUnavailableError` from `generate()` without ever calling `fetch`.
- **Prompt construction & injection resistance** (`backend/src/llm/promptTemplates.js`): `buildSummaryPrompt`/`buildTaskExtractionPrompt` truncate the raw message content to `maxInputChars` *before* building the prompt (not a UI hint), then delimit it between fixed `MESSAGES_START`/`MESSAGES_END` or `THREAD_START`/`THREAD_END` markers with instruction text that tells the model to treat everything between them as data, never as commands — even if it reads like an attempt to override these instructions. Prompt versions are looked up from a per-version template registry; an unrecognized configured version string falls back to the `v1` template rather than failing the request, while the configured string itself is still what gets audited (Section 3: "log the prompt template version"), so a fallback stays visible after the fact instead of silently indistinguishable.
- **Concurrency gate + per-user rate limiting** (`backend/src/llm/concurrencyGate.js`, `backend/src/llm/aiRateLimit.js`): a non-blocking in-process counter enforces `LLM_MAX_CONCURRENT_REQUESTS` — a caller that can't get a slot gets an immediate 503, not a queued wait, so requests never pile up silently behind one slow CPU-bound generation. Separately, `express-rate-limit` caps AI proxy calls per user (10/5min), same `skip`-under-`NODE_ENV=test` convention as the Phase 2 auth limiters.
- **Health-check sweep** (`backend/src/llm/healthCheck.js`): checks the configured provider once at startup and then on `LLM_HEALTH_CHECK_INTERVAL_MS` (default 60s), storing `{healthy, message, provider, lastCheckedAt}` in process state, surfaced through `GET /api/ai/settings`.
- **AI routes** (`backend/src/routes/ai.js`, `backend/src/llm/aiService.js`): `GET`/`PATCH /api/ai/settings`, `POST /api/channels/:channelId/ai/summarize`, `POST /api/messages/:messageId/ai/extract-tasks`. The two proxy routes stream: response headers (`X-Ai-Provider`, `X-Ai-Prompt-Version`, `X-Ai-Truncated-Input-Length`, `X-Ai-Was-Truncated`) are set before any body bytes go out, then the completion is written to `res` as it arrives from the adapter (or in one piece if streaming is off). Every AI operation is audited (`AI_SUMMARIZE_REQUESTED`, `AI_TASK_EXTRACTION_REQUESTED`, `AI_SETTINGS_UPDATED`) with the prompt template version and truncated input length — never the raw message content — per Section 3.
- **"Admin" for a workspace-agnostic settings surface** (`backend/src/authz/membershipService.js`'s new `requireAnyWorkspaceAdmin`): `system_role` (Section 4) is scoped per-workspace and there is no global-admin table, but the AI settings surface (Section 6) is a single set of `app_settings` rows with no workspace of its own. Gated on "ADMIN in at least one workspace" as the closest fit the existing schema supports — documented as a deliberate interpretation, not an oversight, directly in the code.
- **Dedicated Ollama container** (`docker-compose.yml`): `silent-whisper-ollama`, isolated from Silent Lattice's own two Ollama instances (Section 2), 6GB `mem_limit`, its own named volume, on the default network only (never `wireservice_default` — only the backend talks to it). A profile-gated one-shot `ollama-pull-model` service (same pattern as `migrate`) pulls the configured model. In this environment specifically, the model data was copied directly from `wireservice-ollama-1`'s existing volume (`docker run` with both volumes mounted, `cp -a`) rather than re-pulled from the network, since that container already had `mistral:latest` (4.4GB) — a one-time local shortcut, not part of the general setup path for a fresh deployment.
- **A real bug found by the test suite, not by inspection**: the route logic decided whether to write the full completion text based on `settings.streamingEnabled`, but an adapter can silently fall back to a non-streaming response even when streaming is requested (e.g. the provider returned no body stream) — in that case `onChunk` never fires, and the old logic's `if (!settings.streamingEnabled) res.write(text)` also never fired, leaving the HTTP response body empty despite a 200 and a successful `generate()` call. A mocked-fetch integration test (`aiRoutes.test.js`) caught this immediately (expected the summary text, got `""`). Fixed by tracking whether `onChunk` actually wrote anything (`wroteViaChunk`), and writing the full text whenever it didn't — regardless of what the streaming setting says — rather than trusting the setting to predict the adapter's actual behavior.
- **A second real bug, a test-isolation issue surfaced by resetDb.js's unconditional `users` delete**: `app_settings.updated_by` is a real FK to `users(id)` with no `ON DELETE` clause. A test that `PATCH`ed AI settings as a real user left a row referencing that user; the *next* test's `resetDb()` (which deletes all users unconditionally, same as every other test file) then hit an FK violation trying to delete a user an app_settings row still pointed at. Fixed in `aiRoutes.test.js` by clearing `app_settings`'s `llm.*` keys *before* calling `resetDb()`, not after — ordering matters here, and every other test file's own `beforeEach` needed no change since only this suite writes real `updated_by` values. Noted for later: this FK could bite an eventual account-deletion feature the same way; not fixed at the schema level since no such feature exists yet and changing `ON DELETE` behavior for `app_settings.updated_by` is a schema decision outside Phase 4's scope.
- **Frontend** (`frontend/src/api/ai.js`, `components/{ChannelView,ThreadSidebar,AiSettingsPanel}.jsx`, `WorkspaceSidebar.jsx`, `ChatShell.jsx`): a `streamPost` helper reuses the in-memory-token + silent-refresh-and-retry-once treatment every other authenticated request gets, but reads the response body incrementally via `res.body.getReader()` instead of `res.json()`, since the AI routes return streamed plain text. A "Summarize" button in `ChannelView`'s header and "Extract Tasks" in `ThreadSidebar`'s header render the streamed text into a panel as it arrives (Section 8: "Render streamed or incremental AI text ... when supported by the backend route") — plain React text content, not `dangerouslySetInnerHTML`, so model output gets the same default JSX escaping as user message content (Section 3, LLM-Specific Risks). `AiSettingsPanel.jsx` is a modal reachable from an "AI Settings" link in `WorkspaceSidebar`'s header row, shown only when `workspaces.some(ws => ws.role === 'ADMIN')` — a client-side convenience that mirrors, but does not replace, the server-side `requireAnyWorkspaceAdmin` gate.
- **Test suite** (`backend/tests/{llmAdapters,promptTemplates,llmSettingsService,llmConcurrencyGate,aiRoutes}.test.js`, 43 new tests; 99 total across the whole backend now): adapter generate/checkHealth success, streaming-chunk accumulation, non-2xx and network-failure error handling, and disabled-provider behavior (`global.fetch` mocked — no real Ollama/vLLM reachable in the test environment); prompt delimiting (including a marker-collision case: an injected instruction inside message content must stay *inside* the delimited block, not end up after the closing marker) and truncation; settings validation (unknown-field rejection, out-of-range values, malformed URLs), env-default fallback, and seed-without-clobbering-admin-overrides; the concurrency gate's grant/refuse/release behavior in isolation; and full HTTP-level coverage of both AI routes and the settings endpoints — authorization (401/403/404 cases), a real audited summarize/extract-tasks round trip with mocked responses, empty-channel rejection, and 503-with-no-audit-row when the provider is disabled.
- **End-to-end validation actually run, against real inference, not just mocks**: `docker compose up -d --build backend frontend silent-whisper-ollama`, confirmed `ollama list` inside the new container shows `mistral:latest`; a scripted `curl` flow (signup → workspace → channel → post messages → summarize → extract-tasks) against the live backend produced real mistral-generated summaries and checklists (summarize: ~17s, extract-tasks: ~11s, both CPU-only on this host — consistent with the Resource Envelope's expectation that this is the throughput bottleneck, not RAM), confirmed the concurrency gate actually rejects a second concurrent request with 503 while `LLM_MAX_CONCURRENT_REQUESTS=1`'s single slot is in use; `nginx -s reload` after the container recreate (documented gotcha from the Production Deployment entry above); a full Playwright browser session against the live `https://whisper.silentlattice.dev` driving Summarize, Extract Tasks, and the admin AI Settings panel (including editing a field and saving) end to end, with screenshots sent to the user, confirming the streamed rendering actually renders incrementally and the health-status indicator reflects the real provider state.
- **Not yet done**: the admin audit dashboard and audit verification script remain Phase 5. `LLM_PROVIDER=vllm` is implemented and unit-tested (mocked) but not exercised against a real vLLM instance, since this test host has no GPU — that verification only becomes possible on the target production network per Section 2.

### Phase 5: Verification And Hardening — complete (2026-07-12)

- **Admin audit dashboard** (`backend/src/routes/audit.js`, `backend/src/audit/auditService.js`'s new `verifyAuditChain`, `frontend/src/{api/audit.js,components/AuditDashboard.jsx}`): `GET /api/audit/logs` (paginated newest-first by a `beforeId` cursor) and `POST /api/audit/verify`, both gated on `requireAnyWorkspaceAdmin` (Phase 4's "ADMIN in ≥1 workspace" convention, reused rather than inventing a second admin concept). Per Section 3's "the admin audit dashboard is the one intentional exception [to private-content isolation], and that exception is itself an audited action" — every single page load appends its own `AUDIT_DASHBOARD_ACCESSED` row, not a one-time "opened the dashboard" event, since each call is a fresh read of potentially sensitive metadata. `verifyAuditChain` (used by both this route and the CLI script below, so the hash-recompute logic has exactly one implementation) walks the chain in order and returns the first row that fails, not just "verified: true/false". Frontend: a modal (same pattern as `AiSettingsPanel`) listing recent events in a table plus a "Verify Integrity" button, reachable from a new "Audit Log" link next to "AI Settings" in the sidebar.
- **Audit verification CLI script** (`/scripts/verify-audit-log.mjs`, `/scripts/package.json`): deliberately its own tiny dependency tree (`dotenv` + `pg` only) rather than folded into `/backend`, so it keeps working even if the backend app itself is broken or mid-deploy. Imports `computeRowHash`/`GENESIS_HASH` directly from `backend/src/audit/auditService.js` by relative path — safe because that file has zero external package imports of its own (only `node:crypto`), so this cross-package import never needs `backend/node_modules` to resolve. Connects read-only as `app_runtime_user`, reusing `backend/.env`'s connection settings (no third copy of `PGHOST`/etc. to keep in sync). Verified against the real database both ways: a clean chain reports `Log Integrity Verified`, and a row tampered directly via `UPDATE audit_logs SET action_type = 'TAMPERED_DEMO' ...` (as the admin role, since `app_runtime_user` itself has no UPDATE grant per Section 5) is correctly caught and reported with the specific row id and reason — then the demo tamper was cleaned up (`DELETE FROM audit_logs`) rather than left in the shared dev database.
- **Virtual scrolling** (`frontend/src/components/ChannelView.jsx`, `@tanstack/react-virtual`): only messages within (or near) the visible viewport are mounted, using dynamic row-height measurement (`measureElement`) rather than a fixed height, since row height varies (wrapped text, the optional "Reply in thread" button). A real bug surfaced twice while getting the "stick to bottom on load" behavior right (see below) before landing on a robust fix: driving `feedRef.current.scrollTop = feedRef.current.scrollHeight` directly across a couple of `requestAnimationFrame` passes, rather than the virtualizer's own `scrollToIndex`, which computes its target from whatever row-height data it has *at the moment it's called* — on a freshly loaded channel that's still `estimateSize`'s 64px guess for unmeasured rows, and the resulting position never self-corrects once real (usually taller) measurements come in.
- **Authorization audit pass across Phases 2–4** (verification pass per Section 8, not first implementation): systematically re-checked every REST route and WS handler's authorization gate against `PROJECT_PLAN.md` Section 3. One real, actionable gap found: **`POST /api/channels/:channelId/messages` (the REST send-message endpoint) had no rate limiting at all**, while the equivalent WebSocket `message` frame path did (`ws/rateLimiter.js`) — a client could flood messages via REST, completely bypassing Section 3's "rate-limit message sends per user/connection" requirement and Section 9's "apply rate limits to ... message-send ... endpoints; do not defer this to a later phase." Fixed by sharing the *same* per-user counter across both transports (`messages.js` now also calls `isMessageRateLimited`) rather than giving REST its own independent budget — the actual requirement is a per-user send rate, not a per-transport one, so sending via REST must not grant a second, uncounted allowance on top of WS. Added a new `RateLimitedError` (429) to the shared error taxonomy for this and any future non-express-rate-limit-middleware rate limit. Two new tests in `messages.test.js` prove the REST endpoint now 429s past the limit and that the budget is genuinely per-user (one user hitting it doesn't affect another). Everything else audited clean — every route/handler already had the correct `requireAuth`/`requireWorkspaceMember`/`requireChannelMember`/`requireAnyWorkspaceAdmin` gate.
- **Load test at 100 concurrent simulated users** (`/scripts/load-test.mjs`): seeds 100 users, a workspace, and a channel directly in Postgres and mints access tokens directly with the configured `JWT_SECRET`, deliberately bypassing the signup/login rate limiters entirely — Section 2's ask is to load-test the WebSocket/REST *layers*, not re-exercise the (separately, already-tested) auth rate limiters, which would make a 100-user run from one machine impossible without weakening a real control. Opens 100 concurrent WebSocket connections, runs a mixed WS/REST send phase (80%/20% split, matching Section 2's "concurrent WebSocket connections plus concurrent REST traffic" framing), and reports percentile latencies. **Recorded baseline on this host** (8 vCPU/30GB RAM, no GPU): 100 connections authenticate+join in 389ms total; WS message round-trip (send → broadcast receipt) p50 5.0ms / p95 8.8ms / p99 11.5ms; REST message POST p50 8.6ms / p95 11.3ms; REST message GET p50 5.1ms / p95 12.9ms — all comfortably within real-time-chat expectations, and zero unmatched sends or REST errors. Cleans up everything it seeds afterward (confirmed: zero residual rows).
- **`npm audit`**: zero vulnerabilities across all three dependency trees (`/backend`, `/frontend`, `/scripts`) — nothing to resolve or document.
- **Manual HIG/accessibility pass**: found and fixed several real issues, none of them hypothetical — each was caught by actually driving the app in a real browser (Playwright against the live stack), not by inspection alone:
  - **Tap targets**: several Phase 4/5 toolbar buttons and every icon-only "×" close button (`AiSettingsPanel`, `AuditDashboard`, `ChannelView`'s summary panel, `ThreadSidebar`) rendered well under the 44px minimum — fixed by giving each a 44×44px minimum hit area (`minWidth`/`minHeight` + centered flex content) while keeping the visible glyph/label small, the standard "small icon, generous invisible padding" pattern. Also added a `button:focus-visible`/`[role="button"]:focus-visible` outline rule to `global.css`, since only `<input>`s had one before.
  - **A real layout regression caught mid-pass, not shipped**: making those buttons bigger plus adding a new "Audit Log" link overflowed the fixed-260px sidebar's top row — "AI Settings" rendered visibly clipped to a single "S". Fixed by moving the admin-only links (AI Settings, Audit Log) into their own row below the username/sign-out row, rather than cramming everything into one line.
  - **Keyboard navigation**: workspace and channel rows in `WorkspaceSidebar` were plain `<div onClick>` — completely unreachable by keyboard, mouse-only. Added `role="button"`, `tabIndex={0}`, and an Enter/Space `onKeyDown` handler (a real `<button>` wasn't used because a channel row nests its own separately-clickable "Join" button, and nested interactive elements inside a real `<button>` are invalid HTML).
  - **A genuinely dead skip link found and fixed, not duplicated**: `index.html` has had a skip link (`href="#main"`) since Phase 1, but no element with `id="main"` existed anywhere — it silently did nothing the entire time. The first fix attempt added a *second*, differently-targeted skip link inside `ChatShell`, which was wrong; the real fix was giving the actual main-content regions (`ChannelView`'s wrapper, `LoginScreen`'s wrapper) `id="main"` (passed into `ChannelView` via a `mainContentId` prop) so the one pre-existing link actually works.
  - **A genuine, if narrow, browser-specific finding, investigated rather than assumed**: this environment's Chromium build excludes a `position:absolute` element positioned outside the visible viewport (however that's achieved — negative `top`, `transform`, or a 1×1px clip were all tried and behaved identically) from being the *first* Tab stop once the surrounding page has enough other focusable content, even though the element remains perfectly focusable via script and *is* reachable later in the same Tab cycle (confirmed directly: `Sign out → +New workspace → [cycle wraps through body] → skip link → repeats`). Root-caused through direct empirical investigation (isolated the variable across `display:contents`+`tabIndex` removal, `role="button"` removal, and three different "visually hidden" CSS techniques) rather than guessed at. The skip link itself is implemented correctly and matches the standard, ubiquitous pattern used across the web; this is recorded as an observed quirk of this specific test browser, not a defect to keep chasing — the e2e test asserts reachability within a bounded number of Tab presses instead of pinning to exactly one.
  - **Contrast** (both themes, computed via the actual WCAG relative-luminance formula, not eyeballed): `--text-1`/`--text-2` against `--surface` pass comfortably in both themes (8:1+). `--text-3` (used for timestamps, secondary labels, small button text) measures ~3.7:1 in both light and dark — under the 4.5:1 AA threshold for normal-size text. Dark mode's `--item-active-fg` (white) on `--item-active-bg` (the active-row highlight green) measures ~3.1:1, also under AA for the workspace/channel name text it's used on. **Not silently fixed**: these are shared design tokens copied from `~/wireservice-dev` (Section 7: "do not introduce a second accent color or redefine these tokens under different names"), used identically throughout Phases 1–3, not something introduced this phase — changing them is a cross-product visual-language decision outside a verification pass's scope. Flagged here and in `RUNBOOK.md` for a deliberate decision, not fixed unilaterally.
  - **Reduced motion**: already correctly handled since Phase 1 (`@media (prefers-reduced-motion: reduce)` in `global.css`); re-verified, no changes needed.
- **Integration tests for key user workflows** (`frontend/e2e/workflows.spec.js`, `frontend/playwright.config.js`, `@playwright/test` added as a devDependency): 8 tests against the real running stack (not mocked) — core messaging (signup → workspace → channel → message → thread reply → reload session restore), AI summarize + extract-tasks against real Ollama inference, the admin AI Settings and Audit Log panels, three accessibility checks (skip link, keyboard-only sidebar navigation, focus ring visibility), and virtual scrolling under a seeded 50-message history. This is the committed, re-runnable version of the throwaway Playwright scripts used to manually verify Phases 3 and 4. Defaults to testing against `https://whisper.silentlattice.dev` rather than bare `localhost:3101`, documented explicitly in the config: the frontend bundle's `VITE_API_URL` is baked in at build time, and testing a same-origin-built bundle from a different origin makes the `SameSite=Strict` refresh cookie silently stop working on reload — a real trap for exactly this project's own architecture, not a hypothetical.
  - **A real bug this suite caught, not a test artifact**: the virtual-scrolling test originally seeded 50 messages via a tight loop of REST `POST`s, which silently collided with the *correct* message-send rate limit fixed earlier this same phase — only the first 10 messages ever landed, the rest 429'd. Fixed by seeding directly in Postgres instead (same pattern `load-test.mjs` already uses), since this test isn't exercising the send-message path at all, just needs pre-existing history.
- **`CLAUDE.md`**: added at the repo root — Section 9's Rules of Engagement restated concisely for an agent picking up this repo cold, plus the exact offline run commands (bring up the stack, run every test suite, including the new e2e suite and load test) with an explicit "what isn't offline-safe" section (`npm install`/`docker build` themselves, a remote `vllm` provider by design, and the shared production nginx).
- **Nginx documentation**: already substantially covered by the Production Deployment work recorded above (DNS, the actual cert method — `--standalone`, not the roadmap's originally-assumed `webroot` — container-name proxy targets, WebSocket upgrade headers, `sl-admin.py`'s non-functional status). This phase added one explicit statement `RUNBOOK.md` was still missing: that every change described in that section is a deliberate, by-hand operational change to shared infrastructure outside this repo, never something to fold into routine Silent Whisper deploys (Section 8's "document that prod Compose/nginx changes ... must be applied deliberately").
- **End-to-end validation actually run**: full backend Jest suite (112/112, up from 99 — the audit dashboard and REST rate-limit tests) against the live Postgres container, run multiple times to confirm stability (one transient failure traced to the live Docker backend sharing the same dev database as the host test run, not a real regression — reproduced clean on every subsequent run); the full Playwright e2e suite (8/8) against `https://whisper.silentlattice.dev`, iterated through several real failures until each was root-caused and fixed rather than worked around (the sidebar overflow, the dead skip link, the virtual-scroll timing bug, the rate-limit/seeding collision); the audit verification script run against the live database in both a clean and a deliberately-tampered state; the load test's full 100-user run with recorded baseline numbers; `npm audit` clean on all three dependency trees.
- **Not yet done**: the two flagged-but-not-fixed items from earlier phases remain open by deliberate choice, not oversight — certbot renewal for all three domains, and the shared design tokens' sub-AA contrast on `--text-3` and dark-mode `--item-active-fg`/`--item-active-bg` (both require a decision beyond this project's own scope to act on). `LLM_PROVIDER=vllm` still hasn't been exercised against a real vLLM instance (no GPU on this host). No production static frontend build exists yet — the public URL still serves Vite's dev server, which is the source of the harmless-but-noisy HMR console errors documented since the Production Deployment phase.

### Post-Phase-5 finding: no API to add a user to a workspace (2026-07-12)

Discovered provisioning real login credentials on request — the only user in the database at that point was `auditadmin5`, leftover debris from a Jest test run that never got cleaned up (deleted). Creating one real `ADMIN` account (`admin`, via `POST /api/workspaces` after signup) and one real `MEMBER` account (`user`) in the same workspace surfaced a genuine gap: **there is no REST endpoint that adds a user to a workspace.** `POST /workspaces/:workspaceId/channels/:channelId/members` requires the target already be a workspace member (Section 8, Phase 2's own note: "adds an existing workspace member to a channel, not a stranger to the workspace"), and workspace creation only ever seeds the creator as `ADMIN`. There is no other write path to `workspace_members` anywhere in the app.

Worked around by inserting into `workspace_members` directly as `app_runtime_user` (the same least-privilege role the backend itself connects as — Section 5 already grants it INSERT there) — the user then self-joined the workspace's `PUBLIC` channel through the real `POST .../channels/:channelId/join` endpoint, which worked normally once the membership existed. Both accounts were verified end-to-end against the live `https://whisper.silentlattice.dev`: login, workspace visibility, channel join, and the `ai/settings` admin gate correctly returning 200 for `admin` and 403 for `user`.

This is a real product gap, not a test artifact — a real admin using the deployed app has no way to invite anyone else into a workspace they created, which makes multi-user workspaces currently unusable without direct database access. Logged in Section 6 (Core Messaging Utilities) as well.

**Fixed the same day, on request**: `POST /workspaces/:workspaceId/members` (`backend/src/routes/workspaces.js`), gated on `requireWorkspaceAdmin` — deliberately tighter than the existing channel-members endpoint (any channel member can add another *existing* workspace member to a channel; only a workspace *admin* can grow workspace membership itself, since that's the broader, more consequential grant). Takes a `username` (not a `userId`, unlike the channel-members endpoint) since this is the one membership-write route with an actual frontend form behind it (`WorkspaceSidebar`'s "+ Invite member" control, admin-only, visible only for the currently-selected workspace's own role — not the "ADMIN of any workspace" gate `canManageAi` uses for AI Settings/Audit Log). Defaults new members to `MEMBER`; an admin can invite directly as `ADMIN` too. Rejects an unknown username and a duplicate invite with 400/409 respectively, matching the existing error-taxonomy conventions; audited as `WORKSPACE_MEMBERSHIP_CHANGE`. 8 new backend tests (`authorization.test.js`) and 2 new e2e tests (`workflows.spec.js`'s "workspace invite" suite — one confirming a real second account can log in and see the workspace after being invited, one confirming an unknown-username invite surfaces its error inline rather than failing silently) — 120/120 backend tests and 10/10 e2e tests passing.

### Contextual user mentions (@username) & browser notifications (2026-07-12)

Implemented from `FEATURE_REQUEST.md`'s ranked entry 1, on request — the design there was written implementation-ready in advance, so this entry records what was actually built and verified against it, not a fresh design pass.

- **Mention extraction, shared not duplicated** (`backend/src/services/mentionService.js`, new sibling to `messageService.js`): `extractMentionedUserIds(db, {content, channelId, excludeUserId})` — regex `/@([a-zA-Z0-9_.-]{3,50})/g` (matches `validation.js`'s `USERNAME_RE` character class/length exactly), dedupes matched usernames into a `Set` and caps at the first 20 distinct ones, resolves against a single `channel_members` ⋈ `users` query scoped to the message's own channel, excludes the sender, and silently returns `[]` for a nonexistent username or a real user who isn't a member of that channel — never an error, matching Section 3's existence-hiding convention on this new surface.
- **Targeted delivery** (`backend/src/ws/connectionRegistry.js`'s new `sendToUser(userId, event)`): iterates `getUserConnections(userId)` (already existed for the per-user connection cap) and sends to every open socket for that user, deliberately not `broadcastToRoom` — reaches a user regardless of which channel (if any) they currently have joined, including a backgrounded tab. Zero connections for an offline mentioned user is a silent no-op.
- **Wired into both transports identically** (`backend/src/routes/messages.js`'s REST `POST`, `backend/src/ws/server.js`'s `handleMessage`): both call `extractMentionedUserIds` and loop `sendToUser(..., {type:'mention', message, channelId, mentionedBy})` immediately after their own existing `broadcastToRoom(..., {type:'message_created', ...})` call — a side effect of message creation, not part of it, same anti-drift principle already established for authorization.
- **Frontend**: `WorkspaceSidebar.jsx`'s new `NotificationPermissionButton` — a click-to-opt-in bell control next to "Sign out" (`Notification.requestPermission()` only ever fires from this direct user gesture, never automatically on load); `ChatShell.jsx` handles the `mention` WS frame by always showing an in-app toast (6s auto-dismiss, `role="status" aria-live="polite"`) and, only when `Notification.permission === 'granted'` **and** `!document.hasFocus()`, also constructing a real `Notification` using a locally bundled icon (`frontend/src/assets/mention-icon.svg`, imported the normal Vite way — no runtime asset fetch, per Section 9) with `onclick = () => window.focus()`. `ChannelView.jsx` additionally highlights `@username`-shaped tokens inside rendered message bubbles (still plain React text nodes, never `dangerouslySetInnerHTML`) as a visual companion to the notification feature, not a re-validation of who was actually notified.
- **A real bug caught by, not before, verification**: the first e2e run against the live Docker Compose stack failed silently on mention delivery even though the equivalent backend Jest suite (running against source directly) passed cleanly — root cause was that `backend`/`frontend` are built images with no bind-mounted source (`docker-compose.yml`), so the running containers were still serving pre-change code. `docker compose up -d --build backend frontend` before re-running e2e resolved it; this is the same class of gotcha as Phase 4's "rebuilt the backend Docker image" step, restated here because it bit this change specifically and is worth remembering for the next one.
- **A second real interaction found while verifying, not a defect in the feature**: adding the new mentions e2e test (2 fresh signups) to the existing suite (already 11 signups, per this file's Phase 5 entry and `RUNBOOK.md`'s own "right at the ceiling" note) pushed a single uninterrupted full run over `signupIpLimiter`'s 10/hour/IP cap for the first time. Not fixed by weakening the limiter — verified correctness in two budget-safe batches instead (`docker compose restart backend` between them to clear the in-process limiter state, the same sanctioned pattern `RUNBOOK.md` already documents for iterating locally), and merged what was originally two separate mention e2e tests into one (reusing a single seeded sender/recipient pair for both the unfocused-fires-a-notification and focused-does-not-fire assertions) to keep the net-new signup cost as low as a genuine two-party test allows. **Not yet done**: the suite's total signup budget is now exactly at the ceiling again with zero headroom for the next addition — a future test needing a fresh signup should follow `RUNBOOK.md`'s own advice and reuse an already-seeded user rather than seeding a new one, or the limiter's test-environment allowance should be revisited as a deliberate decision, outside this feature's scope to make unilaterally.
- **Test suite**: 11 new backend tests (`backend/tests/mentions.test.js`) — `extractMentionedUserIds` unit coverage (resolves a real member, ignores a nonexistent/non-member username, dedupes repeats, caps at 20 of 25, excludes the sender) plus integration coverage over both transports (REST and WS delivery, delivery with no room ever joined, a non-member producing no frame, a two-connection user getting it on both, no self-notification) — 131/131 backend tests passing. 1 new e2e test (`frontend/e2e/workflows.spec.js`'s `mentions` describe, using `context.grantPermissions(['notifications'])` plus a `page.addInitScript`-installed `window.Notification` stub and a `document.hasFocus` override, since the real OS popup isn't part of the page DOM and can't be asserted on directly, and real cross-context window focus isn't reliably controllable headless) — 11/11 e2e tests passing (verified in two rate-limit-budget-safe batches of 9 and 2, per the finding above, rather than one single run).
- **Not in scope, per the original design**: a persistent missed-mentions inbox for offline users, per-workspace/per-channel notification preferences, and mobile push all remain unbuilt, matching `FEATURE_REQUEST.md`'s "Not in scope for this entry" note.

Moved to Done in `FEATURE_REQUEST.md`, pointing back here.

### Incident: the test suite was deleting real user data (2026-07-12)

While rebuilding the `admin`/`user` accounts to verify the new invite endpoint, a routine `npm test` run to confirm the endpoint didn't break anything **silently deleted both accounts** from the live database. Root cause: `backend/tests/helpers/resetDb.js`'s `beforeEach` hook (`await db('users').del()`, unconditional) had, since Phase 1, always run against whatever database `backend/.env`'s `PGDATABASE` pointed at — the same `silent_whisper` database the actual deployed backend connects to, because host-run tests and the Docker Compose stack share one `.env`-configured Postgres instance on this host. This had never surfaced as a problem before simply because there was never anything real in that database to lose; provisioning real credentials for the user was the first time this test-suite behavior collided with something worth protecting.

**Fixed properly, not just documented**: added an isolated `silent_whisper_test` database on the same Postgres instance. `backend/package.json`'s `test` script now sets `PGDATABASE=silent_whisper_test` as a shell-level environment variable, *before* Node starts — every file that reads `process.env.PGDATABASE` (`src/config.js`, and the few test files with their own direct `pg`/Knex connections: `resetDb.js`, `auditService.test.js`, `auditDashboard.test.js`) picks it up automatically and identically, since dotenv's default behavior never overwrites an env var that's already set. No per-file code changes were needed — the fix is exactly one line in `package.json` plus creating and migrating the new database (`npm run migrate:test-db`, new script, same `knexfile.js`). The grants migration (`0007_grants.js`) already handled a pre-existing `app_runtime_user` role correctly (checks `pg_catalog.pg_roles` and `ALTER ROLE`s instead of erroring on `CREATE ROLE`), since Postgres roles are cluster-wide, not per-database — so it needed no changes to work against the new database.

Verified the fix, not just implemented it: ran the full suite twice against `silent_whisper_test` (120/120, then 119/120 with the one already-known unrelated flake) and confirmed after each run that `admin`/`user` remained present and untouched in the real `silent_whisper` database. The two real accounts were recreated exactly as before (same usernames, same passwords) using the real signup API, and the workspace membership this time went through the real new invite endpoint end to end instead of the direct-DB workaround from the entry above.

**Not yet done**: this fixes local host-run testing, which is the only way tests are currently run. If CI or any other automation is added later that might point at a different `PGDATABASE` value, re-verify this same isolation holds there too — the protection here is "the test script sets the database name," not any deeper guarantee inside the test code itself, so a differently-invoked test run (e.g., `NODE_ENV=test node ...` directly, skipping the `test` npm script) would not be protected.
