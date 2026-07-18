# Silent Whisper — Runbook

This runbook covers day-to-day operation of the local test environment: first-time setup, starting/stopping, migrations, health checks, logs, and troubleshooting. For the design rationale behind any of these choices (why ports are bound to 127.0.0.1, why there are two Postgres roles, why the audit log uses an advisory lock, etc.), see `PROJECT_PLAN.md` — this document assumes that reasoning and just tells you what to run.

**Current implementation status**: Phases 1–4 (Local Foundation And Database Setup; Local Auth And API Base; Real-Time WebSockets And Layout UI; Configurable Local LLM Integration). The app is a working real-time chat client with AI features: sign up, create workspaces/channels, join public channels, send and receive messages live over WebSocket, reply in threads, see presence, summarize a channel and extract action items from a thread via a local Ollama (or vLLM) instance. There is still no admin audit dashboard. See `PROJECT_PLAN.md` Section 11 for exactly what exists, and Section 8 for what's still to come. Sections below marked *(Phase N+)* describe future behavior and don't work yet.

## Start / Stop

```bash
# Start Postgres only
docker compose up -d postgres

# Start everything (postgres, ollama, backend, frontend)
docker compose up -d postgres silent-whisper-ollama backend frontend

# Stop everything (data volume preserved)
docker compose stop

# Stop and remove containers (volume preserved)
docker compose down

# Stop and wipe all data (full reset — you will need to re-run migrations)
docker compose down -v
```

The `migrate` and `ollama-pull-model` services are both profile-gated (`profiles: ["tools"]`) specifically so they never start as part of a normal `up` — they're one-shot jobs you run explicitly:

```bash
docker compose run --rm migrate

# Pulls LLM_MODEL (default "mistral") into silent-whisper-ollama's volume.
# Idempotent — no-ops if the model is already present. Run once after
# silent-whisper-ollama is up and healthy, before using Summarize/Extract Tasks.
docker compose run --rm ollama-pull-model
```

## Service URLs

| Service | Local URL | Notes |
|---|---|---|
| Frontend (production static build, nginx) | http://localhost:3101 | full chat UI — login, workspaces, channels, threads (self-service signup is closed). A Vite dev server can still be run via `docker-compose.dev.yml` — see Frontend Development below |
| Backend health | http://localhost:8101/health | `{"status":"ok","db":"ok","ai":{...},"uptimeSeconds":N}` |
| Backend liveness | http://localhost:8101/health/live | `{"status":"ok"}` — process-alive only, no DB/provider touch |
| Backend REST API | http://localhost:8101/api | see API Reference below |
| Backend WebSocket | ws://localhost:8101/ws | authenticate-frame handshake — see WebSocket Protocol below |
| Postgres | localhost:5433 | `psql -h localhost -p 5433 -U <PGUSER> -d silent_whisper` |
| Silent Whisper's Ollama | not published to the host | only `backend` talks to it, by container name (`silent-whisper-ollama:11434`) over the Compose default network — see AI Features below |

In production, these are reached via `https://whisper.silentlattice.dev` — live since 2026-07-12. See "Production Deployment" below for exactly how nginx reaches this stack (container-name routing over a shared Docker network, **not** `host.docker.internal` — that was the original plan but doesn't actually work given these ports are loopback-only; see below).

### Port Topology and Network Security

| Port | Bound to | Service |
|---|---|---|
| 5433 → 5432 | `127.0.0.1` only | Postgres |
| 8101 → 8000 | `127.0.0.1` only | Backend |
| 3101 → 3000 | `127.0.0.1` only | Frontend |

All three are loopback-only, matching Oracle/Elasticsearch's pattern in the Silent Lattice stack — **not** `0.0.0.0`, which is what `wireservice-dev-frontend-1`/`-api-1` currently do (directly reachable from the internet, bypassing nginx/TLS entirely). Don't change these to `0.0.0.0`; the only public entry point should ever be nginx.

Chosen to avoid collision with the existing Silent Lattice stack, which already uses `3000`/`3001`/`8000`/`8001` (frontend/API), `1521`/`1522` (Oracle), `9201`/`9202` (Elasticsearch), and `11434`–`11436` (Ollama).

## Production Deployment

`https://whisper.silentlattice.dev` is served by the same shared `wireservice-nginx-1` container that fronts `silentlattice.dev` and `dev.silentlattice.dev`. Full incident/deployment writeup: `PROJECT_PLAN.md` Section 11, "Production Deployment: whisper.silentlattice.dev live."

**Everything in this section describes shared infrastructure outside this repo, not app code** — none of it is versioned alongside Silent Whisper's own commits, and it isn't reviewed the way a PR to `/backend` or `/frontend` is. `/root/wireservice`'s `nginx.conf`, the certbot renewal hooks, and the bare `docker run` invocation that starts `wireservice-nginx-1` all live in a *different* repo/host state that Silent Lattice deliberately keeps separate from normal app-code promotion, specifically because it's shared by three domains at once — a mistake here doesn't just affect Silent Whisper. **Editing that shared state** (`nginx.conf`'s contents, certbot hooks, the `docker run` invocation itself) is still something to apply deliberately and confirm with the user first if you're an agent. **Reloading it** (`nginx -s reload`, which `scripts/deploy.sh --reload-nginx` already does) is not the same kind of action — see below.

### Deploying a code change

Deploying is a standard part of finishing a backend or frontend change here, not a separate step to ask about — after a commit lands on `main`, run:

```bash
scripts/deploy.sh                 # build + recreate backend/frontend only
scripts/deploy.sh --reload-nginx  # same, plus reload wireservice-nginx-1
```

Use `--reload-nginx` whenever the change should reach the public `whisper.silentlattice.dev` URL, which is the common case — this is the live, real-traffic instance (`PROJECT_PLAN.md` Section 2), not a staging environment, so most deploys should use it. After deploying, do a quick live smoke test appropriate to the change (`/health` at minimum; for a feature with observable behavior, exercise it directly against the running stack) rather than assuming the deploy worked just because the script exited `0`. If the smoke test creates any data, clean it up afterward with `cd scripts && npm run clear-test-artifacts` (`e2e_`-prefixed usernames get swept automatically) — never leave smoke-test accounts/workspaces behind, and never touch `audit_logs`.

`scripts/deploy.sh` (`FEATURE_REQUEST.md` "the deploy loop" entry, `PROJECT_PLAN.md` Section 11, 2026-07-18) doesn't do anything the manual steps in this section didn't already do — it just removes the chance of forgetting one, which is exactly the recurring bug class (`PROJECT_PLAN.md` Section 11's own log: "the running backend/frontend containers had no source volume mount and were still serving pre-change images," repeated across at least four separate feature entries) this entry was written to close. `--reload-nginx` stays an explicit flag rather than the default specifically so a bare `scripts/deploy.sh` (e.g. during rapid local iteration, before a change is meant to go live) can't accidentally reload shared infrastructure that also fronts `silentlattice.dev`/`dev.silentlattice.dev` — but passing it is the normal, expected case once a change is actually ready to ship, not an escalation.

### How nginx actually reaches this stack

**Not** `host.docker.internal`, despite what an earlier version of this doc and `PROJECT_PLAN.md` Section 2 assumed. `backend` and `frontend` are bound to `127.0.0.1` on the host (see Port Topology above) specifically so they aren't reachable from the internet directly — but that same loopback-only bind also blocks `host.docker.internal` traffic, which arrives via the Docker bridge gateway, a different source address than localhost. `dev.silentlattice.dev`'s equivalent ports are bound to `0.0.0.0`, which is why that pattern happens to work for it.

Instead, `docker-compose.yml` declares `wireservice_default` as an `external` network and attaches `backend`/`frontend` to it (in addition to their own `default` network for talking to `postgres`). Nginx's `whisper.silentlattice.dev` server block proxies to `http://silentwhisper-backend-1:8000` / `http://silentwhisper-frontend-1:3000` directly by container name. This survives normal `docker compose up --build` recreates without any manual `docker network connect` — confirmed by testing a full rebuild+recreate cycle.

### After rebuilding backend or frontend, reload nginx

Recreating a container gives it a new IP. Nginx resolves `proxy_pass` hostnames once (at start/reload) and does **not** notice the IP changed — traffic will 502 with "connect() failed (111: Connection refused)" in nginx's error log against the old, now-dead IP until you reload:

```bash
docker exec wireservice-nginx-1 nginx -s reload
```

Do this every time after `docker compose up -d --build backend` or `... frontend` if the public URL is what you're testing against.

### `wireservice-nginx-1` is not Compose-managed

Despite `sl-admin.py`'s infra menu assuming otherwise (`docker compose ... nginx` — there is no `nginx` service in `/root/wireservice/docker-compose.yml`; that menu's nginx options are currently non-functional no-ops). It's a plain container: image `wireservice-nginx`, built from `/root/wireservice/nginx/Dockerfile` (`COPY nginx.conf /etc/nginx/nginx.conf` — baked in at build time, not bind-mounted), run directly via:

```bash
docker run -d --name wireservice-nginx-1 \
  --network wireservice_default \
  --add-host host.docker.internal:host-gateway \
  --restart unless-stopped \
  -p 80:80 -p 443:443 \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  wireservice-nginx
```

To change `nginx.conf`: edit `/root/wireservice/nginx/nginx.conf`, then either:
- **Fast, no port downtime**: `docker cp` the file into the running container + `nginx -s reload` (validate first with `nginx -t`).
- **Full rebuild** (needed if you also changed the Dockerfile, or want the image itself to match): `docker build -t wireservice-nginx /root/wireservice/nginx/`, then `docker rm -f wireservice-nginx-1` and re-run the `docker run` command above. This briefly drops port 80/443 for **all three domains** — silentlattice.dev and dev.silentlattice.dev included, not just Silent Whisper.

### ⚠ Certbot renewal is currently broken for all three domains

`/etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh` and `post/start-nginx.sh` both run `docker compose stop/start nginx` from `/root/wireservice` — but there's no `nginx` Compose service (see above), so these hooks silently do nothing. `certbot renew`'s standalone authenticator needs port 80 free; nginx occupies it permanently. Left unaddressed, **all three certs** (not just `whisper.silentlattice.dev`'s) will fail to auto-renew around 60 days after issuance (`renew_before_expiry = 30 days` on a 90-day cert). This predates Silent Whisper and isn't specific to it — flagging here because it was discovered while wiring this domain up, and it now affects Silent Whisper's own cert too. Needs a decision: fix the hook scripts to `docker stop`/`docker start wireservice-nginx-1` directly, or migrate to the `webroot` authenticator (no port-80 contention at all — see `PROJECT_PLAN.md` Section 2's original recommendation, not yet acted on).

### Resolved: Vite HMR over the public domain

Previously, the browser console showed a `WebSocket connection ... failed: Unexpected response code: 200` / Vite HMR warning when loading via `https://whisper.silentlattice.dev`, since a Vite dev server (with its own HMR client) was what actually served the public URL. Resolved by "the deploy loop" (`FEATURE_REQUEST.md`, `PROJECT_PLAN.md` Section 11, 2026-07-18) — the public URL now serves a real production static build via nginx, which has no dev-server client to fail in the first place.

## First-Time Setup

### 0. Create and configure `.env` files

Three separate env files exist, for three different run contexts — keep them consistent:

```bash
cp .env.example .env                       # read by docker-compose.yml for all three services
cp backend/.env.example backend/.env       # read if running the backend directly on the host (no Docker)
cp frontend/.env.example frontend/.env     # read if running the frontend directly on the host (no Docker)
```

Fill in real values for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, and `JWT_SECRET` — generate randomly, don't reuse examples:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"   # each password
```

Never commit `.env`, `.env.local`, or any file containing a real secret — only the `.env.example` files (placeholders only) are tracked. See `PROJECT_PLAN.md` Section 3 (Secrets & Configuration) for the full policy.

### 1. Bring up Postgres

```bash
docker compose up -d postgres
docker compose ps    # wait for STATUS to show (healthy)
```

### 2. Run migrations

```bash
docker compose run --rm migrate
```

This creates all 9 application tables (`users`, `workspace_members`, `refresh_tokens`, `workspaces`, `channels`, `channel_members`, `messages`, `audit_logs`, `app_settings`) plus `uuid-ossp`, all indexes from `PROJECT_PLAN.md` Section 4, and the least-privilege `app_runtime_user` role with exactly the grants in Section 5.

Rerunning is safe — Knex tracks applied migrations in `knex_migrations` and only runs what's pending. To verify what's applied:

```bash
cd backend && npx knex --knexfile knexfile.js migrate:status
```

### 2b. Create and migrate the test database (before ever running `npm test`)

```bash
cd backend
node --input-type=module -e "
import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE});
await client.connect();
await client.query('CREATE DATABASE silent_whisper_test');
await client.end();
"
npm run migrate:test-db
```

**Do this before the first `npm test` run, not after.** The test suite deletes data unconditionally on every run (see Running Tests below) — it must never point at the same `silent_whisper` database this step and step 2 just set up.

### 3. Bring up the backend and frontend

```bash
docker compose up -d --build backend frontend
curl http://localhost:8101/health
# {"status":"ok","db":"ok","uptimeSeconds":N}
```

Open http://localhost:3101 — you should see a "Silent Whisper" placeholder card reporting the backend as reachable.

### 3b. Bring up Ollama and pull the model (for AI features)

```bash
docker compose up -d silent-whisper-ollama
docker compose ps    # wait for STATUS to show (healthy)
docker compose run --rm ollama-pull-model   # pulls both LLM_MODEL and EMBEDDING_MODEL
docker exec silentwhisper-silent-whisper-ollama-1 ollama list   # confirm both models landed
```

Skip this if you don't need Summarize/Extract Tasks/Search locally — the backend starts fine either way, and `GET /api/ai/settings` will just report the provider unreachable until this is done (or you set `LLM_PROVIDER=disabled`). See AI Features below for the full picture, including how to reuse an already-pulled model from another Ollama container instead of re-downloading it.

### 4. Create the first user

Self-service signup is closed (`FEATURE_REQUEST.md` entry 1, slice 4, `PROJECT_PLAN.md` Section 11) — every account now originates from a system admin or an invitation, so the very first account on a fresh install has to be created out-of-band:

```bash
cd scripts && node create-first-admin.mjs alice alice@example.com correct-horse-battery
```

Creates a system-admin account directly in Postgres (no HTTP round trip — self-service signup no longer exists to call). Password policy: 10+ characters, not on the common-password deny-list (`backend/src/auth/passwordPolicy.js`). Log in normally afterward to get an access token + refresh cookie:

```bash
curl -s -c cookies.txt -X POST http://localhost:8101/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery"}'
```

From there, use `POST /api/admin/users` (system-admin only) to create further bare accounts, or `POST /api/workspaces/:workspaceId/invitations`/`POST /api/organizations/:orgId/invitations` to invite people who don't have an account yet — see the API Reference below.

## API Reference

All routes except `/api/auth/*` require `Authorization: Bearer <accessToken>`. See `PROJECT_PLAN.md` Section 3 for the authorization model (404 for "not a member", not 403 — see below).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{accessToken, user}` + refresh cookie — self-service signup no longer exists; see "Create the first user" above and `/api/admin/users`/`/api/*/invitations` below |
| POST | `/api/admin/users` | system-admin only. `{username, email, password, organizationId?}` → creates a bare account, no workspace tie |
| GET | `/api/admin/users` | system-admin only. `?limit=&offset=` (default 50, max 100) → `{users, total, limit, offset}`, with `status`/`isSystemAdmin` |
| POST | `/api/admin/users/:userId/disable` \| `/enable` | system-admin only |
| POST | `/api/admin/users/:userId/promote` \| `/demote` | system-admin only. Grants/revokes `is_system_admin`; `/demote` 400s against the caller's own account |
| POST | `/api/admin/users/:userId/reset-password` | system-admin only. `{newPassword}` — global, works regardless of workspace membership |
| GET | `/api/admin/users/:userId/organizations` | system-admin only. Which orgs a given user belongs to, with role |
| GET | `/api/workspaces/admin/all` | system-admin only. `?limit=&offset=` (default 50, max 100) → `{workspaces, total, limit, offset}`, every workspace regardless of membership, across every organization |
| PATCH | `/api/organizations/:orgId` | system-admin only. `{name}` — rename |
| POST | `/api/organizations/:orgId/archive` \| `/unarchive` | system-admin only. Idempotent; an archived org blocks new members/invitations/workspaces but stays browsable |
| POST | `/api/auth/refresh` | reads refresh cookie, rotates it → `{accessToken}` + new refresh cookie |
| POST | `/api/auth/logout` | reads refresh cookie, revokes it → `204` |
| GET | `/api/auth/me` | requires a bearer token → `{user}` — added in Phase 3 so the frontend can restore a session after a bare `/refresh` (which only returns a token, not the user) |
| POST | `/api/workspaces` | `{name}` → creates a workspace; creator becomes its `ADMIN` |
| GET | `/api/workspaces` | list workspaces the caller belongs to |
| POST | `/api/workspaces/:workspaceId/channels` | `{name, type: "PUBLIC"\|"PRIVATE"}` — creator auto-joined |
| GET | `/api/workspaces/:workspaceId/channels` | all `PUBLIC` channels + `PRIVATE` ones the caller has joined |
| POST | `/api/workspaces/:workspaceId/channels/:channelId/join` | self-service join — `PUBLIC` only, 400 for `PRIVATE` |
| POST | `/api/workspaces/:workspaceId/channels/:channelId/members` | `{username}` — caller must already be a channel member; `channelId` must belong to `workspaceId` (400 otherwise); target must already be a member of that same workspace |
| POST | `/api/direct-messages` | `{targetUserId}` → creates or reuses a 1:1 `DIRECT` channel (`workspace_id` is `NULL`) |
| POST | `/api/group-direct-messages` | `{memberIds: [...]}` → creates a `GROUP_DM` channel |
| GET | `/api/channels/:channelId/messages` | `?limit=&before=&parentMessageId=` — newest-first, paginated by timestamp cursor |
| POST | `/api/channels/:channelId/messages` | `{content, parentMessageId?}` — max 10,000 chars |
| GET | `/api/ai/settings` | **system admin only** (`is_system_admin`, not workspace role — see PROJECT_PLAN.md Section 11's 2026-07-17 security-hardening entry) — effective LLM settings (no secrets) + provider health |
| PATCH | `/api/ai/settings` | system admin only — partial update of non-secret settings; unknown fields or out-of-range values are rejected with 400 |
| POST | `/api/channels/:channelId/ai/summarize` | `{limit?}` (default 50, max 200 recent messages) — streamed `text/plain` summary; requires channel membership |
| POST | `/api/messages/:messageId/ai/extract-tasks` | streamed `text/plain` checklist for the thread rooted at `:messageId`; requires membership in that message's channel |
| GET | `/api/audit/logs` | **system admin only** — `?limit=&beforeId=` paginated recent audit events, newest first; **each call is itself audited** (`AUDIT_DASHBOARD_ACCESSED`) |
| POST | `/api/audit/verify` | system admin only — recomputes the whole hash chain server-side, returns `{verified, rowsChecked, firstFailure?}`; audited as `AUDIT_VERIFICATION_ATTEMPTED` |
| POST | `/api/search/semantic` | `{query, workspaceId?, channelId?, limit?}` (limit default 20, max 50) — conceptual search over the caller's own channels, ranked by cosine similarity; see Semantic Search below |

`audit_logs.id` is `BIGSERIAL` — node-postgres returns it as a JSON **string**, not a number (Postgres `int8` avoids silent precision loss beyond 2^53 by round-tripping through the driver as text). Treat `beforeId` as an opaque cursor, never do arithmetic on it.

### Authorization status codes

- **401** — no/invalid/expired access token.
- **404** — authenticated, but not a member of the workspace/channel in question (or it doesn't exist — deliberately indistinguishable from the caller's point of view).
- **403** — authenticated and a member, but lacking a specific privilege (e.g. a non-admin action).
- **400** — malformed input, or a request that's structurally invalid regardless of who's asking (e.g. trying to self-join a `PRIVATE` channel, or attaching a thread reply to a message in a different channel).

### Auth token lifecycle

- Access tokens expire in 15 minutes (`ACCESS_TOKEN_TTL`). The frontend (`frontend/src/api/client.js`) handles this itself now: any `401` triggers one silent `/api/auth/refresh` call and retries the original request. For manual `curl` testing, call `/api/auth/refresh` yourself once the token expires.
- Refresh tokens rotate on every use: each `/api/auth/refresh` call revokes the presented token and returns a new one. **Reusing an old, already-rotated refresh token revokes every other active session for that user** — this is deliberate reuse detection (a replayed token is either a client bug or a stolen token), not a bug, and is audited as `AUTH_REFRESH_REUSE_DETECTED`. If you're testing manually with a saved cookie jar, remember each `curl -b cookies.txt -c cookies.txt` refresh invalidates the previous cookie value. (This bit the frontend during Phase 3 development — see Common Problems, "StrictMode" entry below.)
- `JWT_KEY_ID` (default `v1`) is embedded in every token's header. Bump it alongside rotating `JWT_SECRET` to invalidate all outstanding tokens predictably — see `PROJECT_PLAN.md` Section 3, Secrets & Configuration.

## WebSocket Protocol

Connect to `ws://localhost:8101/ws` (or `WS_PATH` if changed). The connection is unauthenticated — no room data, no joins accepted — until an `authenticate` frame validates.

| Direction | Frame | Notes |
|---|---|---|
| → server | `{type: "authenticate", accessToken}` | required first frame; also used to renew on an already-open connection before the token expires |
| ← server | `{type: "authenticated", userId, reauth, presence}` | `presence` is a `{userId: status}` snapshot of everyone currently tracked |
| → server | `{type: "join", channelId}` | re-validates membership every time, including on reconnect |
| ← server | `{type: "joined", channelId}` | |
| → server | `{type: "leave", channelId}` | |
| → server | `{type: "message", channelId, content, parentMessageId?, clientNonce?}` | `clientNonce` is echoed back only to the sender, for optimistic-UI reconciliation |
| ← server | `{type: "message_created", message, clientNonce}` | broadcast to every socket joined to `channelId` |
| → server | `{type: "heartbeat"}` | send periodically (frontend does this every 20s) to stay marked `online` |
| ← server | `{type: "heartbeat_ack"}` | |
| ← server | `{type: "presence_update", userId, status}` | `status` is `online`, `away`, or `offline` |
| ← server | `{type: "error", error, context}` | never closes the connection except for auth failures / identity mismatch / connection-cap — a bad `join` or rate-limited `message` just gets an error frame |

Close codes: `4001` invalid/missing auth or identity mismatch (also returned for a disabled account's still-unexpired token, indistinguishable from an actually-invalid one), `4002` token expired without renewal, `4003` too many concurrent connections for that user (`WS_MAX_CONNECTIONS_PER_USER`, default 5), `4004` account disabled while the connection was already open — the server closes it immediately rather than waiting for the token to expire (`FEATURE_REQUEST.md` entry 1). A frame larger than `WS_MAX_PAYLOAD_BYTES` (default 131072, 128 KiB) is rejected by the underlying `ws` library itself before it reaches application code, closing with code `1009`.

## AI Features

Channel summarization and thread task extraction (`POST /api/channels/:channelId/ai/summarize`, `POST /api/messages/:messageId/ai/extract-tasks`) go through a configurable local LLM provider — Ollama by default in this test environment, vLLM on the target GPU-backed network, or `disabled` to turn AI features off entirely. See `PROJECT_PLAN.md` Section 2 for the design rationale; this section is just the operational how-to.

### Configuration: env vars vs. `app_settings`

Every `LLM_*` env var (`backend/.env.example`) is a **default**, not the final word — `GET`/`PATCH /api/ai/settings` (admin only) reads and writes the same settings from the `app_settings` table, and a saved value there overrides the env default until changed again. The one exception is `LLM_API_KEY`: it's env-var-only, never stored in `app_settings`, and never returned by `GET /api/ai/settings`.

| Env var | Default here | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` \| `vllm` \| `disabled` |
| `LLM_BASE_URL` | `http://silent-whisper-ollama:11434` | container-name address of this stack's own Ollama |
| `LLM_MODEL` | `mistral` | model tag passed to the provider |
| `LLM_API_KEY` | *(empty)* | optional bearer token for a protected gateway; not needed for this local Ollama |
| `LLM_TIMEOUT_MS` | `30000` | per-request timeout before the adapter gives up |
| `LLM_MAX_INPUT_CHARS` | `12000` | server-side truncation cap, applied before prompt construction |
| `LLM_MAX_OUTPUT_TOKENS` | `512` | passed to the provider as `num_predict`/`max_tokens` |
| `LLM_MAX_CONCURRENT_REQUESTS` | `1` | global in-flight cap — a request beyond this gets an immediate `503`, not a queue |
| `LLM_TEMPERATURE` | `0.3` | |
| `LLM_STREAMING_ENABLED` | `true` | if the provider can't actually stream, the backend still returns the full text in one write |
| `LLM_SUMMARY_PROMPT_VERSION` / `LLM_TASK_PROMPT_VERSION` | `v1` | logged on every AI audit event; an unrecognized version falls back to the `v1` template rather than failing |
| `LLM_HEALTH_CHECK_INTERVAL_MS` | `60000` | not an `app_settings` key — operational only |
| `ALLOWED_LLM_ORIGINS` | *(empty — falls back to `LLM_BASE_URL`'s own origin)* | not an `app_settings` key — comma-separated allowlist of origins `baseUrl` may be changed to via `PATCH /api/ai/settings`; see Switching providers below |

### Checking provider health

```bash
curl -s http://localhost:8101/api/ai/settings -H "Authorization: Bearer <accessToken>" | node -e \
  "process.stdin.on('data',d=>console.log(JSON.parse(d).health))"
# {"healthy":true,"message":"ok","provider":"ollama","lastCheckedAt":"..."}
```

The bearer token must belong to a user who is `ADMIN` of at least one workspace (`requireAnyWorkspaceAdmin` — `app_settings` has no per-workspace scoping of its own, so this is the closest fit; see `backend/src/authz/membershipService.js`). The same status is what the frontend's "AI Settings" panel shows as the green/red dot.

### Streaming response format

`summarize`/`extract-tasks` return `Content-Type: text/plain` with the completion streamed as it's generated (chunked transfer), plus these response headers set *before* the body starts:

```text
X-Ai-Provider: ollama
X-Ai-Prompt-Version: v1
X-Ai-Truncated-Input-Length: 180
X-Ai-Was-Truncated: false
```

A quick manual check (see also the timed example in Common Problems below):

```bash
curl -sN -X POST http://localhost:8101/api/channels/<channelId>/ai/summarize \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' -d '{}'
```

### Ollama container operations

```bash
# List pulled models
docker exec silentwhisper-silent-whisper-ollama-1 ollama list

# Pull/update the configured model (idempotent)
docker compose run --rm ollama-pull-model

# Tail Ollama's own logs (useful when checkHealth reports unreachable)
docker logs -f silentwhisper-silent-whisper-ollama-1
```

**Reusing an already-pulled model instead of re-downloading it**: if another Ollama container on the same host already has the model (e.g. Silent Lattice's own `wireservice-ollama-1`), copy its volume data directly rather than pulling over the network again — this is exactly how `mistral` (4.4GB) was provisioned for this stack the first time:

```bash
docker volume create silentwhisper_silent_whisper_ollama_models   # if it doesn't exist yet
docker run --rm \
  -v wireservice_ollama_data:/from \
  -v silentwhisper_silent_whisper_ollama_models:/to \
  alpine sh -c "cp -a /from/. /to/"
docker compose up -d silent-whisper-ollama
```

Confirm the Compose-managed volume name first (`docker compose config --volumes` or `docker volume ls | grep silentwhisper`) — Compose prefixes volume names with the project name, so a volume created by hand under the bare name in `docker-compose.yml` (`silent_whisper_ollama_models`) is **not** the same volume the `silent-whisper-ollama` service actually mounts.

### Switching providers

Changing `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_MODEL` is a config change only — no code change, no rebuild:

- **Via the admin UI**: "AI Settings" panel (visible to any workspace `ADMIN`) → change Provider/Base URL/Model → Save. Takes effect on the next AI request; the health dot updates on the next sweep (`LLM_HEALTH_CHECK_INTERVAL_MS`, default 60s) or immediately if you reopen the panel (it re-fetches on mount).
- **Via `PATCH /api/ai/settings`**: `{"provider": "vllm", "baseUrl": "http://vllm:8000", "model": "your-model"}`.
- **`baseUrl` must be an allowlisted origin** (Security.md, 2026-07-15, MEDIUM: LLM baseUrl SSRF/DoS) — `ALLOWED_LLM_ORIGINS` restricts what this endpoint (and the admin UI, which calls it) will accept, specifically so an admin session can't be used to point the backend at an arbitrary internal target. A `baseUrl` whose origin isn't in the list 400s with `"baseUrl is not an approved LLM provider origin"` — before switching to `vllm` on the target production network, add that origin to `ALLOWED_LLM_ORIGINS` (a backend restart/redeploy, not an app_settings change) first, or the `PATCH` above will be rejected.
- **To turn AI features off entirely**: `{"provider": "disabled"}` — every summarize/extract-tasks call then returns `503` immediately (`ServiceUnavailableError`), without ever calling out to a provider.

`vllm` is implemented and unit-tested against a mocked OpenAI-compatible endpoint (`/v1/completions`, `/v1/models`) but has not been exercised against a real vLLM instance — this test host has no GPU. Verify against a real instance before relying on it in production.

### Common AI-specific responses

| Status | Meaning |
|---|---|
| `503 "AI features are disabled on this deployment"` | `provider` is `disabled` |
| `503 "AI service is at capacity, please try again shortly"` | `LLM_MAX_CONCURRENT_REQUESTS` slots are all in use — expected under load with the default of `1` on this CPU-only host, not a bug |
| `429 "Too many AI requests..."` | per-user rate limit (10 requests / 5 min) |
| `400 "No messages to summarize in this channel yet"` | empty channel |

### Semantic Search

`POST /api/search/semantic` (FEATURE_REQUEST.md entry, `PROJECT_PLAN.md` Section 11) embeds the query with the same configured `LLM_PROVIDER`/`LLM_BASE_URL` as summarize/extract-tasks, but a separate, smaller model — `EMBEDDING_MODEL` (default `all-minilm`), pulled by the same `docker compose run --rm ollama-pull-model` step above.

| Env var | Default here | Meaning |
|---|---|---|
| `EMBEDDING_MODEL` | `all-minilm` | model tag passed to the provider's embeddings endpoint |
| `EMBEDDING_DIMENSION` | `384` | must match `all-minilm`'s output size *and* `message_embeddings.embedding`'s `vector(N)` column — changing the model to one with a different output size needs a new migration, not just this env var |
| `EMBEDDING_TIMEOUT_MS` | `15000` | |
| `EMBEDDING_MAX_CONCURRENT_REQUESTS` | `1` | separate budget from `LLM_MAX_CONCURRENT_REQUESTS`, so a channel summary in flight doesn't starve the embedding worker or vice versa |
| `EMBEDDING_WORKER_INTERVAL_MS` / `EMBEDDING_WORKER_BATCH_SIZE` | `2000` / `3` | how often, and how many pending messages per tick, the background ingestion worker (`backend/src/search/embeddingWorker.js`) polls |
| `EMBEDDING_MAX_ATTEMPTS` | `5` | a job is dead-lettered (`embedding_jobs.status = 'failed'`) after this many failures — query `embedding_jobs` directly to see the backlog/failures, there's no admin UI for this queue yet |

Every sent message (REST or WebSocket) gets a row in `embedding_jobs`; the worker embeds it asynchronously and writes `message_embeddings`, so **a message sent seconds ago may not be searchable yet** — this is expected async-ingestion lag (bounded by `EMBEDDING_WORKER_INTERVAL_MS`), not a bug. Check backlog directly:

```bash
docker exec silentwhisper-postgres-1 psql -U sw_admin -d silent_whisper \
  -c "SELECT status, count(*) FROM embedding_jobs GROUP BY status;"
```

`LLM_PROVIDER=disabled` disables embedding too (search returns `503`), same as summarize/extract-tasks — there's no separate on/off switch for search.

## Rebuilding After Code Changes

Like Silent Lattice's dev stack, code is baked into the image at build time — there's no source volume mount. After editing backend or frontend source, rebuild the affected service:

```bash
# Rebuild both (or use scripts/deploy.sh — see Production Deployment above)
docker compose up -d --build backend frontend

# Rebuild only the backend
docker compose up -d --build backend

# Rebuild only the frontend
docker compose up -d --build frontend
```

If the public `whisper.silentlattice.dev` URL is what you're testing against, reload nginx afterward too (see "After rebuilding backend or frontend, reload nginx" above) — `scripts/deploy.sh --reload-nginx` does both steps together.

The `backend` and `migrate` services share an image built from repo-root context (`backend/Dockerfile`) specifically so the image also includes `/database` — if you change a migration file, rebuild before running `docker compose run --rm migrate` again, or Compose will silently reuse the stale cached image:

```bash
docker compose run --rm --build migrate
```

## Database Operations

### Connect with psql

```bash
docker exec -it silentwhisper-postgres-1 psql -U <PGUSER> -d silent_whisper
```

### Roll back / re-apply migrations

```bash
cd backend
npx knex --knexfile knexfile.js migrate:rollback --all   # tears down all 7 migrations
npx knex --knexfile knexfile.js migrate:latest            # re-applies them
```

### Check the `app_runtime_user` grants match Section 5

```bash
docker exec silentwhisper-postgres-1 psql -U <PGUSER> -d silent_whisper -c \
  "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='app_runtime_user' ORDER BY table_name, privilege_type;"
```

Expect `SELECT, INSERT, UPDATE, DELETE` on every table except `audit_logs`, which should show only `SELECT, INSERT`.

### Audit log verification script

```bash
cd scripts
npm install       # first time only — its own small dependency tree (dotenv, pg), separate from /backend
node verify-audit-log.mjs
```

Walks `audit_logs` in order, recomputes every row's hash (reusing `computeRowHash`/`GENESIS_HASH` from `backend/src/audit/auditService.js` directly, imported by relative path — safe because that file has zero external package dependencies of its own), and prints either `Log Integrity Verified` (exit 0) or the first row that fails, with its id/timestamp/action/actor and the specific reason (exit 1). Connects read-only as `app_runtime_user`, reusing `backend/.env`'s connection settings — never writes, and works even if the backend app itself isn't running. The admin dashboard's "Verify Integrity" button (`POST /api/audit/verify`) does the same recompute-and-compare over the API instead, and additionally audits the attempt (`AUDIT_VERIFICATION_ATTEMPTED`) — use the CLI tool when you want a check that doesn't depend on the app being up, or don't have an admin account handy.

### Load test

```bash
cd scripts
node load-test.mjs
# Tunable via env vars: LOAD_TEST_USERS (default 100), LOAD_TEST_DURATION_SECONDS (30),
# LOAD_TEST_MESSAGES_PER_USER (5), LOAD_TEST_REST_FRACTION (0.2 — the rest send over WebSocket).
```

Seeds `LOAD_TEST_USERS` users, a workspace, and a channel directly in Postgres (bypassing the signup/login rate limiters entirely — see the script's own header comment for why that's the correct call here, not a workaround), mints access tokens directly with the same `JWT_SECRET`, opens that many concurrent WebSocket connections, runs a mixed WS/REST send phase, and prints p50/p95/p99 latency for connection setup, WS message round-trip, REST message POST, and REST message GET — then deletes everything it seeded. See `PROJECT_PLAN.md` Section 11's Phase 5 log entry for the last recorded baseline numbers on this host.

## Running Tests

```bash
cd backend
npm install
npm test
```

Tests connect to Postgres using `backend/.env`'s host/port/credentials, not a mock — but a **separate database**, `silent_whisper_test`, not the same `silent_whisper` database the live/dev stack uses. `npm test` sets `PGDATABASE=silent_whisper_test` (alongside `NODE_ENV=test`) at the shell level, before Node starts — every file that reads `process.env.PGDATABASE` (`src/config.js`, and the few test files with their own direct `pg`/Knex connections — `resetDb.js`, `auditService.test.js`, `auditDashboard.test.js`) picks it up automatically, since dotenv never overwrites an already-set env var. `npm test` also sets `NODE_ENV=test`, which disables the login/signup rate limiters (`backend/src/auth/rateLimit.js`) — a real test run legitimately signs up far more than 10-20 times from one address, which isn't the credential-stuffing pattern those limiters exist to catch. The limits themselves are unchanged in dev/production.

**⚠ This database separation is load-bearing, not a nicety.** `resetDb()` (`tests/helpers/resetDb.js`) unconditionally deletes every row from `users` (and everything that cascades from it) in `beforeEach` of nearly every test file. Before this was fixed, tests connected to the *same* `silent_whisper` database backing the live deployment — running `npm test` once destroyed every real account on `https://whisper.silentlattice.dev`, discovered when it silently wiped freshly-provisioned admin/user credentials. See `PROJECT_PLAN.md` Section 11's dated "Test suite was deleting real user data" entry for the full incident writeup. If `silent_whisper_test` doesn't exist yet (a fresh clone, or a fresh Postgres volume), create and migrate it first:

```bash
# From backend/, using the admin/migration credentials already in backend/.env
node --input-type=module -e "
import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE});
await client.connect();
await client.query('CREATE DATABASE silent_whisper_test');
await client.end();
"
npm run migrate:test-db
```

Never point `npm test` (or any test file) at the real `silent_whisper` database. If you ever need to verify something against real data, do it read-only, by hand, outside the test suite.

The audit service suite specifically proves:

- the genesis row chains correctly
- a sequential run of inserts forms a linear, recomputable hash chain
- **20 concurrent inserts do not fork the chain** (the actual hazard the `pg_advisory_xact_lock` in `auditService.js` exists to prevent)
- malformed events are rejected
- connecting as `app_runtime_user` (the same role the app itself uses), `UPDATE`/`DELETE` against `audit_logs` fail with a permission error — the append-only guarantee is enforced by the database, not just by application code

The AI tests (`llmAdapters`, `promptTemplates`, `llmSettingsService`, `llmConcurrencyGate`, `aiRoutes`) mock `global.fetch` rather than calling a real Ollama/vLLM — no provider is reachable in the test environment. **If you write a test that saves AI settings as a real user** (anything hitting `PATCH /api/ai/settings` or calling `updateSettings(db, patch, someUserId)` directly), clear `app_settings`'s `llm.*` keys in `beforeEach` *before* calling `resetDb()`, not after — `app_settings.updated_by` is a real FK to `users(id)` with no `ON DELETE` clause, so a leftover row from a previous test can make the next test's `resetDb()` fail deleting users. See `aiRoutes.test.js`'s `beforeEach` for the pattern, and `PROJECT_PLAN.md` Section 11's Phase 4 entry for the full story of how this was found.

### Frontend unit tests

```bash
cd frontend
npm run test:unit
```

Vitest (`frontend/vitest.config.js`), added for the Basic Markdown formatting entry — before that, this app had no frontend unit-test runner at all, only Playwright e2e. Scoped to `src/**/*.test.{js,jsx}` specifically: Vitest's default include glob also matches `e2e/workflows.spec.js`, which is a Playwright spec, not a Vitest one, and errors out if Vitest tries to import it. Uses the same `@vitejs/plugin-react` as the real app build (`vite.config.js`) so JSX compiles with the automatic runtime — without it, any test that actually invokes a tokenizer function returning JSX throws `ReferenceError: React is not defined`. Currently covers `frontend/src/markdown.jsx` (the message-content tokenizer) — tests inspect the returned React element objects directly (`.type`/`.props`), not a rendered DOM, since this is testing tokenizer logic in isolation; the e2e suite's `markdown formatting` describe block covers the real end-to-end path (a message typed through the actual composer, rendered by the real feed).

## Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
docker compose logs -f silent-whisper-ollama
```

## Restarting Individual Services

```bash
docker compose restart backend
docker compose restart frontend
docker compose restart silent-whisper-ollama
```

Since code is baked into the image (no volume mount), a plain `restart` only helps if the problem is process/connection state — for source changes, rebuild instead (see above).

## Frontend Development

`docker compose up -d --build frontend` (or `scripts/deploy.sh`) now builds and serves a real production static bundle (`frontend/Dockerfile`: `vite build` → `nginx:alpine` serving `dist/`, port 3000 published as `127.0.0.1:3101`) — this is what's actually deployed behind `whisper.silentlattice.dev`. It reads `VITE_API_URL`/`VITE_WS_URL` at **build time** as Docker build args (`docker-compose.yml`'s `frontend.build.args`, sourced from the root `.env`) — Vite bakes `import.meta.env.VITE_*` into the bundle, so changing those values requires a rebuild, not just a restart:

```bash
docker compose up -d --build frontend
```

**To run a containerized Vite dev server instead** (hot-reload-friendlier iteration, matching how this service worked before "the deploy loop" entry): use the explicit override, which swaps back to `frontend/Dockerfile.dev` and reads `VITE_*` as runtime environment vars the way the dev server expects:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build frontend
```

This isn't applied by a bare `docker compose up` — `docker-compose.dev.yml` is deliberately not named `docker-compose.override.yml`, so Compose never merges it in automatically. The more common way to iterate on the frontend, though, is running `npm run dev` directly on the host against `frontend/.env` (see First-Time Setup above) rather than through Docker at all.

No component-level unit test suite exists (no Vitest/RTL configured) — real end-to-end coverage against the actual running stack (`frontend/e2e/`, Playwright — see Integration Tests below) is what this project has instead, not a placeholder for it. That real-browser approach is also what caught a React 18 StrictMode double-effect race in Phase 3 that no component-level test could have (see Common Problems below).

## Integration Tests (End-to-End)

```bash
cd frontend
npm install                                      # first time only
npx playwright install chromium                  # first time only, downloads the browser binary
npm run test:e2e
```

Drives the real stack in headless Chromium (`frontend/e2e/workflows.spec.js`) — invitation redemption/workspace/channel/message/thread/session-restore, AI summarize + extract-tasks and semantic search against a real Ollama instance, the admin AI Settings/Audit Log/System Admin dashboards, account disable/enable, workspace ownership transfer/visibility change/`managers_can_archive` delegation, keyboard/accessibility checks (skip link, keyboard-only workspace/channel selection, focus rings), and virtual scrolling under a seeded 50-message history. Not mocked anywhere — this is the same kind of verification every phase's manual Playwright scripts already did, just committed and re-runnable instead of thrown away.

**Defaults to `https://whisper.silentlattice.dev`, not `localhost:3101`** (`playwright.config.js`). This isn't arbitrary: `VITE_API_URL`/`VITE_WS_URL` are baked into the frontend bundle at build time (see Frontend Development above), and in this environment that's normally the public domain. Running the tests against bare `localhost:3101` while the bundle talks to a different origin makes every API call cross-origin — and the refresh-token cookie is `SameSite=Strict` (Section 3), so a cross-site request never sends it, breaking session-restore-on-reload in a way that has nothing to do with the app being broken. Override both `E2E_BASE_URL` and `E2E_API_BASE` together if the frontend was instead built pointing at a same-origin local backend.

**Mind the login rate limiter while iterating.** As of the enterprise authorization model's slice 4 (`FEATURE_REQUEST.md` entry 1, `PROJECT_PLAN.md` Section 11), self-service signup is closed — `seedUserWithChannel`/`seedPlainUser` seed directly in Postgres instead of calling `/auth/signup`, so `signupIpLimiter` (10/hour/IP) is barely touched by a full run anymore (only the couple of tests that redeem a real invitation over `POST /invitations/:token/accept`, which still shares that limiter, brush against it). The live constraint shifted instead to **`loginIpLimiter`** (20/15min/IP — Section 3): nearly every test calls `loginViaUi` at least once, and several call it twice (a sign-out-then-log-back-in flow), so a full ~37-test run comfortably exceeds 20 login attempts from one IP partway through. A single `npx playwright test` run of the whole file will 429 on `POST /auth/login` partway through unless the limiter is reset between batches (`docker compose restart backend` clears the in-process limiter state; acceptable in this dev/test environment, never do this to route around the limiter against real traffic):

```bash
npx playwright test -g "core messaging workflow|markdown formatting|bubble layout|mention autocomplete|admin surfaces|workspace invite|workspace discovery|accessibility"
docker compose restart backend
npx playwright test -g "mentions|change password|admin user management|workspace archive/unarchive|workspace ownership transfer|workspace visibility change|managers_can_archive|workspace member removal|system admin: disable"
docker compose restart backend
npx playwright test -g "Apple HIG overhaul|virtual scrolling|theme toggle|organizations \(FEATURE_REQUEST|workspace token invitations|invitation redemption"
docker compose restart backend
npx playwright test -g "real Ollama inference"
```

Watch for substring overlap between `-g` patterns and *other* describe/test titles when picking batch filters — `-g` matches anywhere in the full test title, not just the describe block you intend; e.g. a bare `"change password"` pattern also matches the `menus` describe block's `selecting "Change Password" from the user menu...` test, silently pulling an extra login into that batch. Re-running the suite repeatedly while debugging burns the same budget from real test traffic, not an attack — every subsequent login attempt 429s with `"Too many attempts"` regardless of username. Invitation emails used in a test must be derived from that test's own unique username (not a hardcoded literal) — this stack has no per-test data reset, so a hardcoded invitee email collides with a previous run's leftover account on the second run.

A real, non-hypothetical example of what this suite catches that nothing else would: bulk-seeding many messages via a tight loop of REST `POST`s hit the very message-send rate limit Section 3 requires (correctly) — the fix was seeding test data directly in Postgres (same pattern as `scripts/load-test.mjs`), not weakening the limiter. See `workflows.spec.js`'s virtual-scrolling test for the pattern.

**Test artifacts are swept automatically after every run.** There's still no reset *between* individual tests within a run (the invitation-email-uniqueness note above still applies), but `playwright.config.js`'s `globalTeardown` (`frontend/e2e/globalTeardown.mjs`) now runs `scripts/clear-test-artifacts.mjs` once after the whole suite finishes, pass or fail — an operator standing instruction ("all test artifacts should be cleaned from the database after tests are run; preserve logs always"), not a per-run judgment call. It deletes every user whose username matches one of the suite's own test-account prefixes (`e2e_` from `uniqueUsername()`, plus `mgmt_created_`/`resetflow_created_`/`dn_created_` from the admin-UI-driven creation flows), and everything that cascades from them (workspaces, channels, messages, memberships, notifications, invitations) — an allowlist match on prefix, not a denylist of specific accounts, so it can't delete a real account by accident just because it wasn't on some hardcoded preserve list. It deliberately never touches `audit_logs`: that table's hash chain (`backend/src/audit/auditService.js`) is sequential across every row regardless of actor, so deleting even test-only rows from the middle of it would break `scripts/verify-audit-log.mjs` for every real row that follows. Run it manually with `cd scripts && npm run clear-test-artifacts` (or `-- --dry-run` to preview counts first) if a run was interrupted before teardown, or after any one-off manual test-data seeding of your own — just use one of the existing prefixes (`e2e_` is the simplest choice) so it gets swept up automatically next time, rather than inventing a new one-off prefix this script doesn't know about.

## Health Checks

```bash
curl http://localhost:8101/health
# {"status":"ok","db":"ok","ai":{"healthy":true,"message":"ok","provider":"ollama","lastCheckedAt":"..."},"uptimeSeconds":12}
```

If `db` comes back `"unreachable"` or the request 503s, Postgres is down, `app_runtime_user` doesn't exist yet (migrations not run), or the backend's `APP_DB_USER`/`APP_DB_PASSWORD` don't match what's actually in the database. `ai` is additive and read-only diagnostic info (FEATURE_REQUEST.md entry 3): it reflects the periodic health sweep's last cached result (`LLM_HEALTH_CHECK_INTERVAL_MS`, default 60s) rather than triggering a fresh provider call on every request, and `ai.healthy: false` never flips `status`/the HTTP code — this endpoint's pass/fail contract stays DB-only.

Docker's own healthcheck (`docker compose ps`) checks the same endpoint from inside the container every 10s.

```bash
curl http://localhost:8101/health/live
# {"status":"ok"}
```

Liveness-only: returns `200` immediately with no DB or provider touch, proving only that the Node process is up and Express is routing requests. Useful for telling "the process itself is wedged, needs a restart" apart from "the process is fine but a dependency (Postgres, the LLM provider) is briefly down" — `/health` alone can't distinguish those two failure modes since it's DB-inclusive by design.

## Resource Usage

Observed on this host (8 vCPU / 30GB RAM / no GPU) with all three Phase 1 services running and idle:

| Service | Observed | Configured limit |
|---|---|---|
| postgres | ~27MB | 1GB |
| backend | ~17MB | 512MB |
| frontend | ~68MB | 128MB |
| silent-whisper-ollama | idle: well under limit; actively generating: several GB while `mistral` is loaded | 6GB |

Actual generation timing observed on this CPU-only host: ~17s for a channel summary, ~11s for thread task extraction (both against `mistral`, default settings). This is the expected bottleneck the low default `LLM_MAX_CONCURRENT_REQUESTS=1` exists for — see `PROJECT_PLAN.md` Section 2.

See `PROJECT_PLAN.md` Section 2 (Local Test Environment Resource Envelope) for the reasoning behind these limits and how they interact with the rest of the Silent Lattice stack sharing this host.

## Common Problems

### `docker compose run --rm migrate` fails with `syntax error at or near "$1"` on `CREATE ROLE`

Already fixed in `database/migrations/0007_grants.js` — Postgres DDL doesn't accept bind parameters for the password literal the way DML does; the migration embeds it as a dollar-quoted literal instead. If you see this again, you've likely reintroduced a `knex.raw('... PASSWORD ?', [pw])`-style call somewhere — don't parameterize values inside `CREATE ROLE`/`ALTER ROLE`.

### `migrate` fails with `APP_DB_PASSWORD must be set`

`.env` (root) is missing `APP_DB_PASSWORD`, or you ran `npx knex` directly on the host without `backend/.env` populated. Both need it — see First-Time Setup, step 0.

### Backend container is `unhealthy` / `/health` returns 503

1. Check Postgres is actually healthy: `docker compose ps postgres`.
2. Check migrations have been run: `cd backend && npx knex --knexfile knexfile.js migrate:status` — if anything is pending, `docker compose run --rm migrate`.
3. Check `APP_DB_USER`/`APP_DB_PASSWORD` in the backend's environment (root `.env`, since `docker-compose.yml` injects these directly) match what the grants migration actually created — if you changed the password in `.env` after the role already existed, rerun `docker compose run --rm --build migrate` (the grants migration `ALTER ROLE`s the password on rerun if the role already exists).

### `docker compose run --rm migrate` doesn't pick up a migration file I just edited

Compose reuses the last-built image unless told otherwise. Force a rebuild:

```bash
docker compose run --rm --build migrate
```

### Frontend shows "Backend unreachable"

- Confirm the backend container is up and healthy (`docker compose ps`).
- Confirm `CORS_ORIGIN` (root `.env`) matches the frontend's actual origin (`http://localhost:3101` by default) — a mismatch causes the browser to block the response even though the backend answered.
- Confirm `VITE_API_URL` was correct **at the time the frontend image was built** — it's baked in at build time, so changing `.env` alone doesn't help; rebuild.

### `429 Too many attempts` while manually testing login/invitations

Expected, not a bug — `backend/src/auth/rateLimit.js` caps login at 20/15min per IP + 10/15min per username, and invitation-acceptance (`POST /invitations/:token/accept`, the only remaining account-creation path that shares `signupIpLimiter`) at 10/hour per IP. If you're exploring the API by hand and hit this, wait out the window or temporarily raise the limits in that file (never disable them outright, and never in a way that ships to production).

### Composer stays disabled after selecting a channel

The message input is intentionally disabled until the WebSocket `join` for that channel is acknowledged (`joined` frame) — this proves the client actually has a live, membership-validated room subscription before letting you send. If it never enables: open the browser console and check for WS `error` frames (most likely a stale/expired access token — reload), or confirm the backend container is actually up (`docker compose ps`).

### A page reload logs you out unexpectedly, or session restore is flaky

This was a real bug during Phase 3 development: React 18 StrictMode double-invokes mount effects in development, so `AuthContext`'s session-restore effect fired `POST /api/auth/refresh` twice. Since refresh tokens rotate-on-use, the second call could hit reuse detection and 401 — and if it resolved after the first call's success, it could clobber `authenticated` back to `anonymous`. Fixed with a `useRef` call-once guard in `frontend/src/context/AuthContext.jsx`. If you ever see spurious logouts on load again, check for a similar un-guarded effect calling a rotate-on-use endpoint.

### WebSocket connects but never receives messages / presence updates

Check the browser console for the `authenticated` frame — if it never arrives, the access token is likely invalid or expired (an access token obtained before a backend restart won't necessarily still verify, depending on `JWT_SECRET`/`JWT_KEY_ID`). Also confirm you're not hitting the per-user concurrent-connection cap (`WS_MAX_CONNECTIONS_PER_USER`, default 5) — e.g. many open tabs during testing.

### Port already in use (`5433`, `8101`, or `3101`)

Something else on the host is using that port. Check what: `ss -tlnp | grep <port>`. These were chosen specifically to avoid the existing Silent Lattice stack's ports (`3000/3001/8000/8001/1521/1522/9201/9202/11434-11436`) — if you still collide, change the host-side port in `docker-compose.yml` (the container-side port can stay the same).

### "AI Settings"/"Audit Log" rows don't appear in the Admin hub

Both are **system-admin only** (`is_system_admin`, not any workspace role — PROJECT_PLAN.md Section 11's 2026-07-17 security-hardening entry; see scripts/grant-system-admin.mjs for how to provision one). Being OWNER/MANAGER of a workspace is not enough, and does not need to be — that only unlocks the hub's separate "Manage Users" row. This is a client-side convenience only — hiding the rows doesn't grant or deny anything by itself, `GET`/`PATCH /api/ai/settings` and `GET /api/audit/logs`/`POST /api/audit/verify` all re-check `is_system_admin` server-side on every request.

### `GET /api/ai/settings` shows `"healthy": false`

Confirm the provider container is actually up and has the model: `docker compose ps silent-whisper-ollama` and `docker exec silentwhisper-silent-whisper-ollama-1 ollama list`. If the model isn't listed, run `docker compose run --rm ollama-pull-model` (see AI Features above). If the provider is up and healthy but `GET /api/ai/settings` still shows stale/unreachable state, remember the sweep only runs every `LLM_HEALTH_CHECK_INTERVAL_MS` (default 60s) — it isn't checked fresh on every settings read.

### Summarize/Extract Tasks returns `503 "AI service is at capacity"`

Not a bug — `LLM_MAX_CONCURRENT_REQUESTS` (default `1` on this CPU-only host) is a hard, non-queued cap: a request that can't get a slot is refused immediately rather than waiting behind whatever's already generating. Retry after the in-flight request finishes (summaries/extractions typically take 10-20s against `mistral` on this host — see Resource Usage above), or raise the limit via the AI Settings panel if this host has headroom to actually sustain more concurrent CPU-bound generations (it usually doesn't, until this moves to GPU-backed vLLM).

### A just-sent message doesn't show up in Search results yet

Expected async-ingestion lag, not a bug — see Semantic Search above. Check `embedding_jobs` directly (`SELECT status, count(*) FROM embedding_jobs GROUP BY status`) to see whether it's still `pending` (worker hasn't ticked yet, bounded by `EMBEDDING_WORKER_INTERVAL_MS`) or `failed` (check `last_error`; usually means `EMBEDDING_MODEL` was never pulled — `docker compose run --rm ollama-pull-model`).

### Nginx caches DNS after recreating `backend`/`silent-whisper-ollama`

Same underlying issue as the Production Deployment note above, but worth restating here since it also affects `LLM_BASE_URL` resolution if `silent-whisper-ollama` gets recreated (new container IP) without recreating `backend` alongside it: `backend`'s own DNS resolution of `silent-whisper-ollama` is fresh per-request (Node's `fetch`, not nginx), so this specific case usually self-heals — it's nginx's cached resolution of `backend`/`frontend` (the containers actually behind the public `whisper.silentlattice.dev` proxy) that needs the manual `nginx -s reload` documented above.
