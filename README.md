# Silent Whisper

Offline-first, workspace-based messaging platform for project teams — Slack-style channels, direct messages, group conversations, threaded replies, server-side presence, an immutable hash-chained audit log, and configurable local LLM-powered AI utilities (channel summaries, action-item extraction).

Runs fully on local or intranet infrastructure. No external CDNs, no externally hosted assets, no public AI APIs.

Designed to be deployable alongside the existing Silent Lattice stack, served under its own hostname (`whisper.silentlattice.dev`) through the same shared nginx entrypoint.

**Full design rationale, security baseline, scalability targets, and phase-by-phase roadmap**: see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).
**Day-to-day operations (start/stop, migrations, troubleshooting)**: see [`RUNBOOK.md`](./RUNBOOK.md).

## Status

Phase 1 (Local Foundation And Database Setup) is complete and verified end-to-end. See `PROJECT_PLAN.md` Section 11 (Implementation Log) for exactly what's built and tested so far. Auth, WebSockets, the LLM proxy, and the real chat UI are not yet implemented (Phases 2–5).

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vite + React |
| Backend | Node.js (Express), `ws` (Phase 3+) |
| Database | PostgreSQL via Knex.js (query building + migrations) |
| AI | Ollama (this test environment, CPU-only) / vLLM (target GPU-backed network) — Phase 4 |
| Container runtime | Docker Compose |

## Monorepo layout

```text
/frontend   Vite + React client application
/backend    Node.js API, WebSocket server, auth, audit, and configurable LLM proxy
/database   PostgreSQL migrations, grants, and seed data (Knex)
/scripts    audit verification and local maintenance utilities
```

## Quick start

Prerequisites: Docker, Docker Compose, Node.js 20+ (for running tests/migrations from the host).

```bash
# 1. Copy env templates and fill in real values (never commit the resulting .env files)
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# 2. Bring up Postgres
docker compose up -d postgres

# 3. Apply migrations (creates schema + the least-privilege app_runtime_user role)
docker compose run --rm migrate

# 4. Bring up the backend and frontend
docker compose up -d --build backend frontend
```

Then:
- Frontend: http://localhost:3101
- Backend health: http://localhost:8101/health

Full setup detail, port topology, and troubleshooting: [`RUNBOOK.md`](./RUNBOOK.md).

## Running tests

```bash
cd backend
npm install
npm test
```

The audit service tests run against a real Postgres (the one from `docker compose up -d postgres`) — the correctness guarantee they check is a database-level advisory lock, so there's no meaningful way to mock it out.

## Security & secrets

- Never commit `.env`, `.env.local`, or any real credential — only `.env.example` files with placeholders are tracked.
- Full secrets-handling rules: `PROJECT_PLAN.md` Section 3 (Secrets & Configuration).
