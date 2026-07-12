# Silent Whisper — Runbook

This runbook covers day-to-day operation of the local test environment: first-time setup, starting/stopping, migrations, health checks, logs, and troubleshooting. For the design rationale behind any of these choices (why ports are bound to 127.0.0.1, why there are two Postgres roles, why the audit log uses an advisory lock, etc.), see `PROJECT_PLAN.md` — this document assumes that reasoning and just tells you what to run.

**Current implementation status**: Phase 1 (Local Foundation And Database Setup) only. There is no auth, no WebSocket layer, no LLM integration, and no real chat UI yet — see `PROJECT_PLAN.md` Section 11 for exactly what exists, and Section 8 for what's still to come. Sections below marked *(Phase N+)* describe future behavior and don't work yet.

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
| Frontend (Vite dev server) | http://localhost:3101 | placeholder screen only until Phase 3 |
| Backend health | http://localhost:8101/health | `{"status":"ok","db":"ok","uptimeSeconds":N}` |
| Backend REST API | http://localhost:8101/api | *(Phase 2+ — no routes exist yet)* |
| Backend WebSocket | ws://localhost:8101/ws | *(Phase 3+ — doesn't exist yet)* |
| Postgres | localhost:5433 | `psql -h localhost -p 5433 -U <PGUSER> -d silent_whisper` |

In production, these are reached via `whisper.silentlattice.dev` (see `PROJECT_PLAN.md` Section 2, Serving Under Silent Lattice) — the shared nginx proxy reaches this stack through `host.docker.internal` on the ports above, not by joining `wireservice_default`.

### Port Topology and Network Security

| Port | Bound to | Service |
|---|---|---|
| 5433 → 5432 | `127.0.0.1` only | Postgres |
| 8101 → 8000 | `127.0.0.1` only | Backend |
| 3101 → 3000 | `127.0.0.1` only | Frontend |

All three are loopback-only, matching Oracle/Elasticsearch's pattern in the Silent Lattice stack — **not** `0.0.0.0`, which is what `wireservice-dev-frontend-1`/`-api-1` currently do (directly reachable from the internet, bypassing nginx/TLS entirely). Don't change these to `0.0.0.0`; the only public entry point should ever be nginx.

Chosen to avoid collision with the existing Silent Lattice stack, which already uses `3000`/`3001`/`8000`/`8001` (frontend/API), `1521`/`1522` (Oracle), `9201`/`9202` (Elasticsearch), and `11434`–`11436` (Ollama).

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

### 4. Create the first user *(Phase 2+ — doesn't exist yet)*

No signup/login endpoints exist yet. This section will cover `POST /api/auth/signup` once Phase 2 lands.

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

Tests connect to Postgres using `backend/.env` — they run against a real database (currently `localhost:5433`, i.e. the `docker compose up -d postgres` instance), not a mock. The audit service suite specifically proves:

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

### Port already in use (`5433`, `8101`, or `3101`)

Something else on the host is using that port. Check what: `ss -tlnp | grep <port>`. These were chosen specifically to avoid the existing Silent Lattice stack's ports (`3000/3001/8000/8001/1521/1522/9201/9202/11434-11436`) — if you still collide, change the host-side port in `docker-compose.yml` (the container-side port can stay the same).
