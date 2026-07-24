# Silent Whisper — Agent Instructions

Offline-first Slack-style messaging platform. Full design rationale: `PROJECT_PLAN.md`. Day-to-day operations, API reference, and troubleshooting: `RUNBOOK.md`. Read those before making non-trivial changes — this file is a short, agent-facing summary, not a replacement for either.

## Rules of engagement

(Full list: `PROJECT_PLAN.md` Section 9.)

- No code that fetches assets over the internet at runtime; no external CDNs.
- Never trust browser time for anything security- or audit-relevant — server-generated timestamps only.
- Enforce authorization server-side on every REST call and WebSocket event; never rely on the UI to hide something a user isn't authorized to see.
- Refresh tokens live in `httpOnly` cookies; access tokens stay in memory only — never `localStorage`/`sessionStorage`.
- Treat all user-generated content and LLM output as untrusted when rendering.
- Delimit user content from instructions in any LLM prompt template.
- Rate-limit authentication, message-send, and AI proxy endpoints — not optional, not a later phase.
- Write tests alongside each backend module, frontend feature, and script, including negative-authorization tests.
- Zero hardcoded secrets — see `PROJECT_PLAN.md` Section 3, Secrets & Configuration, and the `.env.example` files.
- **Every commit that changes `backend/`, `frontend/`, `scripts/`, or `database/migrations/` behavior gets a `CHANGELOG.md` entry and a version bump in the same commit** — all three `package.json`s, `.env.enclave.example`'s `SILENTWHISPER_VERSION` default, and a matching `vX.Y.Z` git tag, using `CHANGELOG.md`'s own PATCH/MINOR/MAJOR rule to pick the bump. Not a follow-up step to remember later. This is what makes `scripts/airgap-upgrade.sh` — and an operator deciding whether to run it — possible at all; a change that ships without this is invisible to the enclave upgrade path. See `CHANGELOG.md`'s own "Versioning" section and `RUNBOOK.md`'s "Enclave Upgrade" section.
- **`backend/tests/helpers/resetDb.js` unconditionally deletes every user (and everything that cascades from it) before nearly every test.** `npm test` must run against `silent_whisper_test`, never the real `silent_whisper` database — it already does (`PGDATABASE=silent_whisper_test` is baked into the `test` script), but if you ever construct your own DB connection outside that script, or change how `PGDATABASE` is resolved, double-check this before running anything. This has already destroyed real login credentials once — see `PROJECT_PLAN.md` Section 11's "Test suite was deleting real user data" entry and `RUNBOOK.md`'s Running Tests section.

## Offline run commands

Everything below assumes Docker images have already been pulled/built at least once and `npm install` has already populated `node_modules` in `/backend`, `/frontend`, and `/scripts` — this project promises to remain usable with no public internet access once those are in place (PROJECT_PLAN.md Section 10, Acceptance Criteria). None of the commands below reach out to the network.

```bash
# 1. Bring up the full local stack (Postgres, this project's own dedicated
#    Ollama instance, backend, frontend). Uses images already built locally.
docker compose up -d postgres silent-whisper-ollama backend frontend

# 2. First run only (or after a schema change): apply migrations.
docker compose run --rm migrate

# 3. First run only: pull the configured model into the Ollama volume.
#    Skip this if the model is already present (idempotent either way).
docker compose run --rm ollama-pull-model

# Health check
curl http://localhost:8101/health

# Stop everything (data volumes preserved)
docker compose stop
```

Frontend: http://localhost:3101 — Backend API: http://localhost:8101/api — WS: ws://localhost:8101/ws.

### Running the test suites offline

```bash
# Backend unit/integration tests (against a SEPARATE silent_whisper_test
# database on the same Postgres instance from step 1 — never the real one;
# see RUNBOOK.md's Running Tests section if silent_whisper_test doesn't
# exist yet)
cd backend && npm test

# Audit log integrity check (standalone CLI, its own small node_modules)
cd scripts && node verify-audit-log.mjs

# Load test (100 simulated concurrent users against the local stack)
cd scripts && node load-test.mjs

# Frontend e2e workflow tests (Playwright — browser binaries must already be
# cached; see RUNBOOK.md's Running Tests section for E2E_BASE_URL/E2E_API_BASE
# if the frontend wasn't built pointing at whisper.silentlattice.dev)
cd frontend && npm run test:e2e
```

### What isn't offline-safe

- `npm install` / `docker compose build` themselves need network access the first time (or when a dependency changes) — that's dependency acquisition, not running the app, and is outside the "usable offline" promise.
- `LLM_PROVIDER=vllm` pointed at a remote GPU-backed host is inherently a network dependency on that host, by design (PROJECT_PLAN.md Section 2) — the default `LLM_PROVIDER=ollama` in this environment talks only to the local `silent-whisper-ollama` container.
- Production deployment behind `wireservice-nginx-1` (RUNBOOK.md's Production Deployment section) obviously requires that host's network — it's a separate, operational concern from running the project itself.
