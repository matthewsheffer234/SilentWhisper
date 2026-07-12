# Silent Whisper — Runbook

This runbook covers day-to-day operation of the local test environment: first-time setup, starting/stopping, migrations, health checks, logs, and troubleshooting. For the design rationale behind any of these choices (why ports are bound to 127.0.0.1, why there are two Postgres roles, why the audit log uses an advisory lock, etc.), see `PROJECT_PLAN.md` — this document assumes that reasoning and just tells you what to run.

**Current implementation status**: Phases 1–3 (Local Foundation And Database Setup; Local Auth And API Base; Real-Time WebSockets And Layout UI). The app is a working real-time chat client: sign up, create workspaces/channels, join public channels, send and receive messages live over WebSocket, reply in threads, see presence. There is still no LLM integration and no admin audit dashboard. See `PROJECT_PLAN.md` Section 11 for exactly what exists, and Section 8 for what's still to come. Sections below marked *(Phase N+)* describe future behavior and don't work yet.

## Start / Stop

```bash
# Start Postgres only
docker compose up -d postgres

# Start everything (postgres, backend, frontend)
docker compose up -d postgres backend frontend

# Stop everything (data volume preserved)
docker compose stop

# Stop and remove containers (volume preserved)
docker compose down

# Stop and wipe all data (full reset — you will need to re-run migrations)
docker compose down -v
```

The `migrate` service is profile-gated (`profiles: ["tools"]`) specifically so it never starts as part of a normal `up` — it's a one-shot job you run explicitly:

```bash
docker compose run --rm migrate
```

## Service URLs

| Service | Local URL | Notes |
|---|---|---|
| Frontend (Vite dev server) | http://localhost:3101 | full chat UI — login/signup, workspaces, channels, threads |
| Backend health | http://localhost:8101/health | `{"status":"ok","db":"ok","uptimeSeconds":N}` |
| Backend REST API | http://localhost:8101/api | see API Reference below |
| Backend WebSocket | ws://localhost:8101/ws | authenticate-frame handshake — see WebSocket Protocol below |
| Postgres | localhost:5433 | `psql -h localhost -p 5433 -U <PGUSER> -d silent_whisper` |

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

### Known cosmetic issue: Vite HMR over the public domain

Browser console shows `WebSocket connection ... failed: Unexpected response code: 200` and a Vite HMR warning when loading via `https://whisper.silentlattice.dev`. This is Vite's *own* dev-server hot-reload client failing (nginx's `/` location has no WebSocket upgrade headers, only `/ws` does) — it does not affect the application, whose own `/ws` endpoint is proxied correctly and was verified directly. Harmless; the real fix is serving a production static build instead of a dev server behind the public URL, not yet done.

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

### 3. Bring up the backend and frontend

```bash
docker compose up -d --build backend frontend
curl http://localhost:8101/health
# {"status":"ok","db":"ok","uptimeSeconds":N}
```

Open http://localhost:3101 — you should see a "Silent Whisper" placeholder card reporting the backend as reachable.

### 4. Create the first user

```bash
curl -s -c cookies.txt -X POST http://localhost:8101/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"correct-horse-battery"}'
```

Returns `{"accessToken": "...", "user": {...}}` and sets a `refresh_token` cookie (saved to `cookies.txt` above by curl's `-c` flag). Password policy: 10+ characters, not on the common-password deny-list (`backend/src/auth/passwordPolicy.js`).

## API Reference

All routes except `/api/auth/*` require `Authorization: Bearer <accessToken>`. See `PROJECT_PLAN.md` Section 3 for the authorization model (404 for "not a member", not 403 — see below).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/signup` | `{username, email, password}` → `{accessToken, user}` + refresh cookie |
| POST | `/api/auth/login` | `{username, password}` → `{accessToken, user}` + refresh cookie |
| POST | `/api/auth/refresh` | reads refresh cookie, rotates it → `{accessToken}` + new refresh cookie |
| POST | `/api/auth/logout` | reads refresh cookie, revokes it → `204` |
| GET | `/api/auth/me` | requires a bearer token → `{user}` — added in Phase 3 so the frontend can restore a session after a bare `/refresh` (which only returns a token, not the user) |
| POST | `/api/workspaces` | `{name}` → creates a workspace; creator becomes its `ADMIN` |
| GET | `/api/workspaces` | list workspaces the caller belongs to |
| POST | `/api/workspaces/:workspaceId/channels` | `{name, type: "PUBLIC"\|"PRIVATE"}` — creator auto-joined |
| GET | `/api/workspaces/:workspaceId/channels` | all `PUBLIC` channels + `PRIVATE` ones the caller has joined |
| POST | `/api/workspaces/:workspaceId/channels/:channelId/join` | self-service join — `PUBLIC` only, 400 for `PRIVATE` |
| POST | `/api/workspaces/:workspaceId/channels/:channelId/members` | `{userId}` — caller must already be a channel member; target must already be a workspace member |
| POST | `/api/direct-messages` | `{targetUserId}` → creates or reuses a 1:1 `DIRECT` channel (`workspace_id` is `NULL`) |
| POST | `/api/group-direct-messages` | `{memberIds: [...]}` → creates a `GROUP_DM` channel |
| GET | `/api/channels/:channelId/messages` | `?limit=&before=&parentMessageId=` — newest-first, paginated by timestamp cursor |
| POST | `/api/channels/:channelId/messages` | `{content, parentMessageId?}` — max 10,000 chars |

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

Close codes: `4001` invalid/missing auth or identity mismatch, `4002` token expired without renewal, `4003` too many concurrent connections for that user (`WS_MAX_CONNECTIONS_PER_USER`, default 5).

## Rebuilding After Code Changes

Like Silent Lattice's dev stack, code is baked into the image at build time — there's no source volume mount. After editing backend or frontend source, rebuild the affected service:

```bash
# Rebuild both
docker compose up -d --build backend frontend

# Rebuild only the backend
docker compose up -d --build backend

# Rebuild only the frontend
docker compose up -d --build frontend
```

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

### Audit log verification script *(Phase 5 — doesn't exist yet)*

Will live at `/scripts/verify-audit-log.js` and walk `audit_logs` recomputing each row's hash, per `PROJECT_PLAN.md` Section 6.

## Running Tests

```bash
cd backend
npm install
npm test
```

Tests connect to Postgres using `backend/.env` — they run against a real database (currently `localhost:5433`, i.e. the `docker compose up -d postgres` instance), not a mock. `npm test` sets `NODE_ENV=test`, which disables the login/signup rate limiters (`backend/src/auth/rateLimit.js`) — a real test run legitimately signs up far more than 10-20 times from one address, which isn't the credential-stuffing pattern those limiters exist to catch. The limits themselves are unchanged in dev/production.

The audit service suite specifically proves:

- the genesis row chains correctly
- a sequential run of inserts forms a linear, recomputable hash chain
- **20 concurrent inserts do not fork the chain** (the actual hazard the `pg_advisory_xact_lock` in `auditService.js` exists to prevent)
- malformed events are rejected
- connecting as `app_runtime_user` (the same role the app itself uses), `UPDATE`/`DELETE` against `audit_logs` fail with a permission error — the append-only guarantee is enforced by the database, not just by application code

## Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

## Restarting Individual Services

```bash
docker compose restart backend
docker compose restart frontend
```

Since code is baked into the image (no volume mount), a plain `restart` only helps if the problem is process/connection state — for source changes, rebuild instead (see above).

## Frontend Development

The frontend dev server runs Vite with `--host` (so it's reachable from outside the container) at container port 3000, published as `127.0.0.1:3101`. It reads `VITE_API_URL`/`VITE_WS_URL` at **build time** (Vite bakes `import.meta.env.VITE_*` into the bundle) — changing `frontend/.env` or the root `.env`'s `VITE_*` values requires a rebuild, not just a restart:

```bash
docker compose up -d --build frontend
```

No automated frontend test suite exists yet (no Vitest/RTL configured) — this is a real gap, not a decision. Phase 3 was verified with the backend Jest suite plus actually driving the app in a real headless-Chromium session (see PROJECT_PLAN.md Section 11); that browser run is what caught a React 18 StrictMode double-effect race that no backend test could have (see Common Problems below).

## Health Checks

```bash
curl http://localhost:8101/health
# {"status":"ok","db":"ok","uptimeSeconds":12}
```

If `db` comes back `"unreachable"` or the request 503s, Postgres is down, `app_runtime_user` doesn't exist yet (migrations not run), or the backend's `APP_DB_USER`/`APP_DB_PASSWORD` don't match what's actually in the database.

Docker's own healthcheck (`docker compose ps`) checks the same endpoint from inside the container every 10s.

## Resource Usage

Observed on this host (8 vCPU / 30GB RAM / no GPU) with all three Phase 1 services running and idle:

| Service | Observed | Configured limit |
|---|---|---|
| postgres | ~27MB | 1GB |
| backend | ~17MB | 512MB |
| frontend | ~68MB | 128MB |

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

### `429 Too many attempts` while manually testing signup/login

Expected, not a bug — `backend/src/auth/rateLimit.js` caps signup at 10/hour per IP and login at 20/15min per IP + 10/15min per username. If you're exploring the API by hand and hit this, wait out the window or temporarily raise the limits in that file (never disable them outright, and never in a way that ships to production).

### Composer stays disabled after selecting a channel

The message input is intentionally disabled until the WebSocket `join` for that channel is acknowledged (`joined` frame) — this proves the client actually has a live, membership-validated room subscription before letting you send. If it never enables: open the browser console and check for WS `error` frames (most likely a stale/expired access token — reload), or confirm the backend container is actually up (`docker compose ps`).

### A page reload logs you out unexpectedly, or session restore is flaky

This was a real bug during Phase 3 development: React 18 StrictMode double-invokes mount effects in development, so `AuthContext`'s session-restore effect fired `POST /api/auth/refresh` twice. Since refresh tokens rotate-on-use, the second call could hit reuse detection and 401 — and if it resolved after the first call's success, it could clobber `authenticated` back to `anonymous`. Fixed with a `useRef` call-once guard in `frontend/src/context/AuthContext.jsx`. If you ever see spurious logouts on load again, check for a similar un-guarded effect calling a rotate-on-use endpoint.

### WebSocket connects but never receives messages / presence updates

Check the browser console for the `authenticated` frame — if it never arrives, the access token is likely invalid or expired (an access token obtained before a backend restart won't necessarily still verify, depending on `JWT_SECRET`/`JWT_KEY_ID`). Also confirm you're not hitting the per-user concurrent-connection cap (`WS_MAX_CONNECTIONS_PER_USER`, default 5) — e.g. many open tabs during testing.

### Port already in use (`5433`, `8101`, or `3101`)

Something else on the host is using that port. Check what: `ss -tlnp | grep <port>`. These were chosen specifically to avoid the existing Silent Lattice stack's ports (`3000/3001/8000/8001/1521/1522/9201/9202/11434-11436`) — if you still collide, change the host-side port in `docker-compose.yml` (the container-side port can stay the same).
