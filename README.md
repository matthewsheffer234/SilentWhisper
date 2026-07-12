# Silent Whisper

Offline-first, workspace-based messaging platform for project teams — Slack-style channels, direct messages, group conversations, threaded replies, server-side presence, an immutable hash-chained audit log, and configurable local LLM-powered AI utilities (channel summaries, action-item extraction).

Runs fully on local or intranet infrastructure. No external CDNs, no externally hosted assets, no public AI APIs.

Deployed alongside the existing Silent Lattice stack, served under its own hostname through the same shared nginx entrypoint: **https://whisper.silentlattice.dev**.

**Full design rationale, security baseline, scalability targets, and phase-by-phase roadmap**: see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).
**Day-to-day operations (start/stop, migrations, troubleshooting)**: see [`RUNBOOK.md`](./RUNBOOK.md).
**Agent-facing rules of engagement and offline run commands**: see [`CLAUDE.md`](./CLAUDE.md).

## Status

All five phases (Local Foundation And Database Setup; Local Auth And API Base; Real-Time WebSockets And Layout UI; Configurable Local LLM Integration; Verification And Hardening) are complete. Full workflow, verified end-to-end including driving the real UI in a headless browser against the live public URL: sign up, create a workspace, create/join channels, send and receive messages live over WebSocket with optimistic rendering and virtual scrolling for long histories, reply in threads, presence badges, session restore across a page reload, channel summarization and thread task extraction against a real local Ollama/mistral instance with streamed rendering, an admin AI settings panel, and an admin audit dashboard with a live integrity-verification button all work. A 100-concurrent-user load test, a full authorization audit pass, a manual HIG/accessibility pass, and a committed Playwright integration-test suite (`frontend/e2e/`) back this up — see `PROJECT_PLAN.md` Section 11 (Implementation Log) for exactly what's built and tested, including every real bug found and fixed along the way, and `RUNBOOK.md` for operations, the API reference, and troubleshooting. **Known issues, flagged for a deliberate decision rather than silently fixed**: certbot's renewal hooks are non-functional for all three domains on this server (not just Silent Whisper's); the shared `~/wireservice-dev` design tokens' `--text-3` and dark-mode active-row contrast measure under WCAG AA for their font sizes; `LLM_PROVIDER=vllm` is implemented and unit-tested but not exercised against a real vLLM instance (this test host has no GPU); no production static frontend build exists yet (the public URL still serves Vite's dev server) — see RUNBOOK.md for detail on each.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vite + React |
| Backend | Node.js (Express + `ws`) |
| Database | PostgreSQL via Knex.js (query building + migrations) |
| AI | Ollama (this test environment, CPU-only) / vLLM (target GPU-backed network), via a shared provider-adapter interface |
| Container runtime | Docker Compose |

## Monorepo layout

```text
/frontend   Vite + React client application
/backend    Node.js API, WebSocket server, auth, audit, and configurable LLM proxy
/database   PostgreSQL migrations, grants, and seed data (Knex)
/scripts    audit log verification, load testing, and local maintenance utilities
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

# 4. Bring up Ollama (dedicated to Silent Whisper) and pull the configured model
docker compose up -d silent-whisper-ollama
docker compose run --rm ollama-pull-model

# 5. Bring up the backend and frontend
docker compose up -d --build backend frontend
```

Then:
- Frontend: http://localhost:3101
- Backend health: http://localhost:8101/health
- AI provider health (as a workspace admin): `GET /api/ai/settings`

Full setup detail, port topology, and troubleshooting: [`RUNBOOK.md`](./RUNBOOK.md).

## Running tests

```bash
cd backend
npm install
npm test
```

Tests run against a real Postgres — but a separate `silent_whisper_test` database on that same instance, never the one the running app itself uses (`RUNBOOK.md`'s Running Tests section explains why that separation matters and how to set it up on a fresh clone). The audit service tests specifically need a real database, not a mock, since the correctness guarantee they check is a database-level advisory lock.

Real-browser integration tests (signup through AI features to the admin audit dashboard, against the actual running stack) live in `frontend/e2e/` and run via `cd frontend && npm run test:e2e` — see `RUNBOOK.md`'s Integration Tests section before running these, including a note on the signup rate limiter. The audit log's own integrity can be checked independently with `cd scripts && node verify-audit-log.mjs`, and the system can be load-tested at 100 concurrent users with `cd scripts && node load-test.mjs`.

## Security & secrets

- Never commit `.env`, `.env.local`, or any real credential — only `.env.example` files with placeholders are tracked.
- Full secrets-handling rules: `PROJECT_PLAN.md` Section 3 (Secrets & Configuration).
