# Silent Whisper

Offline-first, workspace-based messaging platform for project teams — Slack-style channels, direct messages, group conversations, threaded replies, server-side presence, an immutable hash-chained audit log, and configurable local LLM-powered AI utilities (channel summaries, action-item extraction).

Runs fully on local or intranet infrastructure. No external CDNs, no externally hosted assets, no public AI APIs.

Deployed alongside the existing Silent Lattice stack, served under its own hostname through the same shared nginx entrypoint: **https://whisper.silentlattice.dev**.

**Full design rationale, security baseline, scalability targets, and phase-by-phase roadmap**: see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).
**Day-to-day operations (start/stop, migrations, troubleshooting)**: see [`RUNBOOK.md`](./RUNBOOK.md).

## Status

Phases 1–4 (Local Foundation And Database Setup; Local Auth And API Base; Real-Time WebSockets And Layout UI; Configurable Local LLM Integration) are complete and verified end-to-end, including driving the real UI in a headless browser against both the local environment and the live public URL: sign up, create a workspace, create/join channels, send and receive messages live over WebSocket with optimistic rendering, reply in threads, presence badges, session restore across a page reload, channel summarization and thread task extraction against a real local Ollama/mistral instance with streamed rendering, and an admin AI settings panel all work. See `PROJECT_PLAN.md` Section 11 (Implementation Log) for exactly what's built and tested — including several real bugs found and fixed along the way — and `RUNBOOK.md`'s API Reference / WebSocket Protocol / AI Features / Production Deployment sections for the wire format, LLM provider configuration, and how the public URL is actually wired up. The admin audit dashboard and audit verification script are not yet implemented (Phase 5). **Known issues**: certbot's renewal hooks are currently non-functional for all three domains on this server (not just Silent Whisper's), and `LLM_PROVIDER=vllm` is implemented and unit-tested but not exercised against a real vLLM instance (this test host has no GPU) — see RUNBOOK.md.

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

The audit service tests run against a real Postgres (the one from `docker compose up -d postgres`) — the correctness guarantee they check is a database-level advisory lock, so there's no meaningful way to mock it out.

## Security & secrets

- Never commit `.env`, `.env.local`, or any real credential — only `.env.example` files with placeholders are tracked.
- Full secrets-handling rules: `PROJECT_PLAN.md` Section 3 (Secrets & Configuration).
