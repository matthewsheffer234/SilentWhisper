# Silent Whisper

Offline-first, workspace-based messaging platform for project teams — organizations and workspaces, Slack-style channels, direct messages, ad-hoc group DMs, deep threaded replies, server-side presence, an immutable hash-chained audit log, semantic (pgvector) search, and configurable local LLM-powered AI utilities (channel summaries, thread action-item extraction, cross-channel "Catch Me Up" digests).

Runs fully on local or intranet infrastructure. No external CDNs, no externally hosted assets, no public AI APIs.

Deployed alongside the existing Silent Lattice stack, served under its own hostname through the same shared nginx entrypoint: **https://whisper.silentlattice.dev**.

**Full design rationale, security baseline, scalability targets, phased roadmap, and the complete implementation log**: see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).
**Day-to-day operations (start/stop, migrations, API reference, troubleshooting)**: see [`RUNBOOK.md`](./RUNBOOK.md).
**Agent-facing rules of engagement and offline run commands**: see [`CLAUDE.md`](./CLAUDE.md).
**Proposed/planned feature backlog, ranked by utility, with a Done log of everything shipped**: see [`FEATURE_REQUEST.md`](./FEATURE_REQUEST.md).
**Independent security review and UI/UX review**: see [`Security.md`](./Security.md) and [`UI_UX_REVIEW.md`](./UI_UX_REVIEW.md).

## Status

The original five-phase roadmap (Local Foundation And Database Setup; Local Auth And API Base; Real-Time WebSockets And Layout UI; Configurable Local LLM Integration; Verification And Hardening) is complete, and substantial product work has shipped on top of it since. `PROJECT_PLAN.md` Section 11 (Implementation Log) is the authoritative, chronological record of exactly what's built and tested, including every real bug found and fixed along the way — this section is a summary, not a replacement for it.

**Core platform**: sign up/login, an enterprise authorization model (organizations → workspaces → channels, with system-admin/org-owner/org-manager/workspace-owner/workspace-manager/member roles), workspace and channel creation (public/private), direct messages and group DMs with dedicated navigation, deep threaded replies, real-time delivery over WebSocket with optimistic rendering and virtual scrolling for long histories, server-side presence, session restore across a page reload, and a Light/Dark/System appearance toggle.

**Messaging UX**: display names as the primary identity (usernames as secondary), basic Markdown formatting, iMessage-style bubbles in DMs vs. left-aligned grouped/avatared messages with visible authorship in channels, @mention autocomplete with browser + in-app notifications, a double-bracket (`[[Entity Name]]`) entity registry with autocomplete and clickable entity detail pages, semantic message/channel search via pgvector, and a persistent notification panel covering both mentions and pending membership invitations.

**AI (local LLM)**: channel summarization, thread action-item extraction, and a cross-channel "Catch Me Up" workspace digest, all served through a provider-adapter interface (Ollama in this test environment, vLLM on the target GPU-backed network) with per-user rate limiting, a global concurrency cap, streamed rendering, and full audit coverage. Actions are surfaced through a scoped "AI Actions" menu rather than always-visible pills.

**Admin & operations**: a dedicated Admin hub (AI settings with live provider health, audit dashboard with a live integrity-verification button, workspace user management, org management, System Admin panel for account/org provisioning and disable/enable), workspace settings consolidated into one sheet, confirmation dialogs for destructive/high-impact actions (archive, transfer ownership, remove member, revoke invitation, reset password, disable account), and actionable workspace-home empty states for new/empty workspaces.

**Verified**: a 100-concurrent-user load test, a full authorization audit pass, a manual HIG/accessibility pass, and a committed Playwright integration-test suite (`frontend/e2e/`) driving the real UI in a headless browser against the live public URL, in addition to backend unit/integration tests and frontend Vitest tests. See `PROJECT_PLAN.md` Section 11 for current pass counts (they grow with each entry) and `RUNBOOK.md` for operations, the API reference, and troubleshooting.

**Known issues, flagged for a deliberate decision rather than silently fixed**:
- The remaining Medium/Low findings from the 2026-07-15 security review are not yet fixed: disabled-account access windows (an already-issued access token/WebSocket session stays usable until its ~15-minute expiry even after an admin disables the account), the LLM provider `baseUrl` accepts any admin-supplied origin (SSRF/DoS potential), archived-workspace/org invitations can still be redeemed, and there's no WebSocket payload cap or group-DM member cap. The two High-severity findings from the same review (global admin self-escalation via workspace ownership; cross-workspace channel-member injection) are fixed — see `PROJECT_PLAN.md` Section 11, "Security hardening: global admin boundary and cross-workspace channel-member injection" (2026-07-17). Full detail: [`Security.md`](./Security.md); remaining remediation tracked as backlog entry 1 in [`FEATURE_REQUEST.md`](./FEATURE_REQUEST.md) (**Status: Proposed**).
- Certbot's renewal hooks are non-functional for all three domains on this server (not just Silent Whisper's).
- The shared `~/wireservice-dev` design tokens' `--text-3` and dark-mode active-row contrast measure under WCAG AA for their font sizes.
- `LLM_PROVIDER=vllm` is implemented and unit-tested but not exercised against a real vLLM instance (this test host has no GPU).
- No production static frontend build exists yet — the public URL still serves Vite's dev server.

See `RUNBOOK.md` for detail on each of the non-security items above.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vite + React |
| Backend | Node.js (Express + `ws`) |
| Database | PostgreSQL via Knex.js (query building + migrations), with `pgvector`/`pg_trgm` for semantic search and entity autocomplete |
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
- AI provider health (as a system admin): `GET /api/ai/settings`

Full setup detail, port topology, and troubleshooting: [`RUNBOOK.md`](./RUNBOOK.md).

## Running tests

```bash
cd backend
npm install
npm test
```

Tests run against a real Postgres — but a separate `silent_whisper_test` database on that same instance, never the one the running app itself uses (`RUNBOOK.md`'s Running Tests section explains why that separation matters and how to set it up on a fresh clone). The audit service tests specifically need a real database, not a mock, since the correctness guarantee they check is a database-level advisory lock.

```bash
cd frontend
npm install
npm run test:unit
```

Frontend Vitest coverage is deliberately narrow — pure-logic modules (Markdown/entity rendering, permission checks, theme resolution, message-grouping/reply-count helpers) rather than full component trees; component-level behavior is covered in e2e instead.

Real-browser integration tests (signup through AI features to the admin audit dashboard, against the actual running stack) live in `frontend/e2e/` and run via `cd frontend && npm run test:e2e` — see `RUNBOOK.md`'s Integration Tests section before running these, including a note on the signup rate limiter. The audit log's own integrity can be checked independently with `cd scripts && node verify-audit-log.mjs`, and the system can be load-tested at 100 concurrent users with `cd scripts && node load-test.mjs`.

## Security & secrets

- Never commit `.env`, `.env.local`, or any real credential — only `.env.example` files with placeholders are tracked.
- Full secrets-handling rules: `PROJECT_PLAN.md` Section 3 (Secrets & Configuration).
- The two High-severity findings from the 2026-07-15 security review are fixed; several Medium/Low findings remain open — see Known Issues above and [`Security.md`](./Security.md) before relying on this deployment for anything beyond local/intranet testing.
