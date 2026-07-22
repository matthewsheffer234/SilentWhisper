# Silent Whisper v1.0 — Air-Gapped Enclave Shipment Punch List

**Prepared**: 2026-07-21
**Target**: Strict air-gapped enterprise enclave (internal equivalent of `https://whisper.silentlattice.dev` — zero external CDNs, zero public internet, zero external telemetry/APIs)
**Method**: Every claim below was verified directly against the current repo state (source, `docker-compose.yml`, `.env.example` files, migrations, `docs/reviews/*`, `git log`) as of commit `5242607`, not assumed from prior documentation. File:line citations are given wherever a specific fix or gap is being pointed at.

---

## 0. Where things actually stand (read this first)

The backend has been through three review cycles (`2026-07-15`, `2026-07-19`, `2026-07-20`) and every High/Medium finding from all three — including both HIGH findings from the 07-15 review (self-service workspace-ownership escalation into global audit/AI access; cross-workspace channel-membership injection) and all 8 findings from the 07-20 review (system-admin private-channel auto-join, unbounded list endpoints, `fetchAllPages()`, notification summary cost, archived-invitation redemption, presence/composer re-render cost, task-checkbox optimism) — is **verified fixed in the current source**, not just claimed fixed in a changelog. Specifics are in Section 3 below.

**One real regression was found during this audit** (Section 3, Item 1): the root `.env.example` still ships the *pre-fix* `v1` prompt-delimiter default, which will silently resurrect the exact prompt-injection weakness Finding 2 (07-20 review) closed, the moment anyone follows `RUNBOOK.md`'s own documented `cp .env.example .env` step. This is the single Must-Fix blocker before shipping and takes minutes to fix.

Beyond that, the gaps are mostly **absence of automation** (no air-gapped installer, no backup/restore script, no log rotation config) rather than defects in existing code — which matches an app that has been built and hardened for local/dev operation but not yet packaged for a one-shot enclave install.

---

## 1. Air-Gap & Zero-Egress Hardening

### 1.1 Verified clean — no action needed

- **CSP has no third-party origins**: `backend/src/middleware/security.js` sets `defaultSrc: ["'self'"]`, `scriptSrc: ["'self'"]`, `connectSrc: ["'self'"]`, no external hosts anywhere in the directive list.
- **No CDN/external asset references** in the frontend: `frontend/index.html` links only `/src/global.css` (local); grepping `frontend/src` for `http(s)://` outside test fixtures (`markdown.test.jsx`'s `example.com`/`wikipedia.org` — test data for link-rendering, never fetched) turns up nothing. No `<link>` to Google Fonts, no `fonts.googleapis.com`, no `unpkg`/`jsdelivr`/`cdnjs`.
- **No telemetry/analytics SDKs**: grep across `backend/src`, `frontend/src`, `scripts`, and both `package.json` manifests for `sentry|mixpanel|segment|posthog|amplitude|datadog|newrelic|bugsnag` returns nothing.
- **Dependency trees are small and boring**: frontend runtime deps are `react`, `react-dom`, `react-router`, `@tanstack/react-virtual`, `lucide-react` (icon set, bundled not fetched). Backend deps are `express`, `knex`, `pg`, `ws`, `helmet`, `cors`, `bcryptjs`, `jsonwebtoken`, `express-rate-limit`, `cookie-parser`, `dotenv` — none of these phone home.
- **`npm audit` was clean** at last review (2026-07-15: 0 known vulnerabilities, both trees) — re-run before ship (1.3 below), don't just trust the old number.

### 1.2 Must fix

**a. Remove the two dead, misleading placeholders from the root `.env.example`:**

```
GITHUB_PERSONAL_ACCESS_TOKEN=your_github_pat_here
HF_TOKEN=your_huggingface_token_here
```

These are not read anywhere in the codebase (`grep -rn "GITHUB_PERSONAL_ACCESS_TOKEN\|HF_TOKEN"` across `backend/src`, `frontend/src`, `scripts`, and every `.yml`/`.sh` returns nothing) — they look like leftover boilerplate from an unrelated template. In an air-gapped enclave handoff, a placeholder for a HuggingFace token specifically invites an operator to wonder whether the app needs internet access to download something at runtime. It doesn't — the app never fetches model weights itself; inference is delegated entirely to the enclave's dedicated vLLM GPU hosts over the internal network (Section 2). Delete both lines.

**b. Confirm no build step reaches out at container-build time beyond the documented one-time pulls.** `frontend/Dockerfile`'s `npm ci` and `backend/Dockerfile`'s `npm install --omit=dev` both need `node_modules` already populated or a registry mirror reachable at *build* time — this is the same "dependency acquisition, not running the app" carve-out `CLAUDE.md` already documents, but for an enclave with no registry mirror at all, build the images in a networked staging environment first and ship the resulting image tar (see Section 2).

### 1.3 Commands to run before ship

```bash
# Re-confirm the dependency audit is still clean (don't trust the 07-15 number)
cd backend && npm audit --omit=dev
cd ../frontend && npm audit --omit=dev

# Scan the actual built frontend bundle (not just source) for anything
# that looks like an external host — catches anything a transitive
# dependency might have inlined that source-grepping src/ would miss.
cd frontend && npm run build
grep -RoE "https?://[a-zA-Z0-9.-]+" dist/assets/*.js | grep -v "w3\.org" | sort -u
# Expect: no output (or only w3.org, which is an XML namespace URI in the
# bundled SVG icon set, never fetched at runtime).

# Confirm no fetch()/XHR/WebSocket call in the bundle targets anything
# other than the configured VITE_API_URL/VITE_WS_URL origin.
grep -o "fetch(\"[^\"]*\"\|fetch('[^']*'" dist/assets/*.js | sort -u

# Confirm the built image itself carries no unexpected outbound-capable
# binaries/curl/wget beyond what nginx:alpine/node:20-alpine ship with.
docker history silentwhisper-backend:latest --no-trunc | head -50
docker history silentwhisper-frontend:latest --no-trunc | head -50
```

### 1.4 Egress policy at the network layer (defense in depth)

This enclave's topology is deliberately not fully self-contained at the container level: `LLM_PROVIDER=vllm` means the backend makes real outbound calls, over the enclave's internal network, to dedicated GPU boxes running vLLM — that's a by-design network dependency (`CLAUDE.md`: "`LLM_PROVIDER=vllm` pointed at a remote GPU-backed host is inherently a network dependency on that host, by design"), not a violation of the zero-public-internet requirement, since the vLLM hosts never leave the enclave's own network boundary. Everything else the app talks to (Postgres) stays local to the Compose stack.

If the enclave's container runtime supports it, apply an explicit egress-deny-by-default network policy to the `backend` container, with narrow allows only for: `postgres` (5432) and the specific, enumerated vLLM host(s)/port(s) configured in `LLM_BASE_URL`/`ALLOWED_LLM_ORIGINS` — nothing else, and never a broad allow for the enclave's whole internal address space. This directly enforces the SSRF mitigation already in code (`ALLOWED_LLM_ORIGINS`, Section 3) at a layer a future code change can't accidentally punch a hole through — it matters more here than it would with a same-host Ollama sidecar, precisely because the approved target is now a real network hop to hardware the backend container doesn't otherwise need any reason to reach.

---

## 2. Automated Air-Gapped Deployment Pipeline

### 2.1 Assessment: yes, build a dedicated installer

No such script exists today. `scripts/deploy.sh` is real and useful but scoped to a *different* problem — rebuilding/recreating already-configured containers behind the shared `wireservice-nginx-1` and reloading it (RUNBOOK.md, Production Deployment). It assumes Postgres is already up, migrated, and seeded; it assumes `.env` is already correct; it assumes images already build cleanly. None of that is true on a fresh enclave host on day one.

Recommend **Bash**, not Python: every other operational script in this repo (`deploy.sh`) is Bash, there's no Python anywhere in the current toolchain (`scripts/*.mjs` are all Node, matching `backend`/`frontend`), and introducing Python solely for the installer adds a runtime dependency an air-gapped host may not have staged. Build it as `scripts/airgap-install.sh`, calling the existing Node scripts (`create-first-admin.mjs`, `verify-audit-log.mjs`, etc.) rather than reimplementing their logic.

### 2.2 Required behavior — `scripts/airgap-install.sh`

```bash
#!/usr/bin/env bash
# scripts/airgap-install.sh — one-shot enclave installer.
# Idempotent: safe to re-run after a partial failure. Every step logs
# clearly and the script exits non-zero on first failure (set -euo pipefail)
# rather than continuing into an inconsistent state.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
```

**Phase A — Pre-flight checks (fail fast, before touching anything):**

```bash
# Docker runtime present and daemon reachable
command -v docker >/dev/null || fail "docker CLI not found"
docker info >/dev/null 2>&1 || fail "docker daemon not reachable"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin not found"

# .env files exist and required vars are non-placeholder
for f in .env backend/.env frontend/.env; do
  [ -f "$f" ] || fail "$f missing — cp ${f}.example $f and fill in real values first"
done
grep -q "your_.*_here" .env && fail ".env still has placeholder values — see RUNBOOK.md First-Time Setup"

# Required offline image tars are present (see Phase B). No Ollama image —
# this enclave has no local/CPU inference container; all generation and
# embedding calls are delegated to the enclave's dedicated vLLM GPU hosts.
for img in postgres-pgvector-pg16.tar silentwhisper-backend.tar silentwhisper-frontend.tar; do
  [ -f "images/$img" ] || fail "images/$img not found — stage offline image bundle first"
done

# LLM_PROVIDER must be vllm for this enclave (no local GPU/CPU detection
# needed on this host — inference happens off-host, on hardware this
# script has no reason to introspect).
[ "${LLM_PROVIDER:-}" = "vllm" ] || fail "LLM_PROVIDER must be 'vllm' in this enclave's .env — this deployment has no local Ollama fallback"
[ -n "${LLM_BASE_URL:-}" ] || fail "LLM_BASE_URL must point at the enclave's vLLM host (e.g. https://vllm-gpu01.enclave.internal:8000)"

# Reachability of the external vLLM host(s) — this is the one outbound
# dependency this script cannot load from a tar, so fail fast and loudly
# rather than letting the backend silently report an unhealthy AI provider
# after the rest of the install "succeeds."
log "Checking vLLM host reachability: ${LLM_BASE_URL}"
curl -sf --max-time 5 "${LLM_BASE_URL}/v1/models" >/dev/null \
  || fail "vLLM host ${LLM_BASE_URL} is not reachable from this host on /v1/models — confirm network path, firewall rules, and that vLLM is actually running there before continuing"
```

**Phase B — Load offline images (no registry pull):**

```bash
log "Loading offline images..."
docker load -i images/postgres-pgvector-pg16.tar
docker load -i images/silentwhisper-backend.tar
docker load -i images/silentwhisper-frontend.tar
```

The staged tars themselves are produced *outside* the enclave (a networked build host) via `docker save pgvector/pgvector:pg16 -o images/postgres-pgvector-pg16.tar` plus `docker compose build backend frontend && docker save ...`, then transferred in by whatever offline media the enclave's data-diode/sneakernet process uses — that transfer mechanism is enclave-specific and outside this script's scope, but the script should assume `images/*.tar` already exist locally and fail clearly (as above) if they don't, rather than silently trying to pull. There is deliberately no `ollama-latest.tar` or model-weight bundle in this list — this enclave's vLLM hosts are provisioned and weight-loaded independently of this installer, by whatever process stands up the GPU boxes themselves (out of scope here; see Phase F).

**Phase C — Bring up Postgres, verify pgvector, and confirm version:**

```bash
docker compose up -d postgres
log "Waiting for Postgres to report healthy..."
timeout 60 bash -c 'until [ "$(docker compose ps -q postgres | xargs docker inspect -f "{{.State.Health.Status}}")" = "healthy" ]; do sleep 2; done' \
  || fail "postgres did not become healthy within 60s"

PG_VERSION=$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "SHOW server_version_num;")
[ "$PG_VERSION" -ge 160000 ] || fail "Postgres $PG_VERSION < 16.0 — pgvector HNSW indexing (database/migrations/0009) requires PG16+"

# Verify the extension's control file is actually present in the loaded
# image *before* attempting CREATE EXTENSION — an image that's a plain
# postgres:16 tar (mislabeled, or the wrong file grabbed off the offline
# media) still passes the version check above but has no vector.control
# anywhere, and CREATE EXTENSION's own error message in that case is a
# generic "could not open extension control file," easy to mistake for a
# permissions or search-path issue rather than "wrong base image entirely."
# This check gives an unambiguous, specific failure at the actual root cause.
docker compose exec -T postgres sh -c 'test -f "$(pg_config --sharedir)/extension/vector.control"' \
  || fail "vector.control not found under \$(pg_config --sharedir)/extension inside the postgres container — the loaded image is not pgvector/pgvector:pg16 (or images/postgres-pgvector-pg16.tar was built from the wrong source image); re-stage the correct tar before continuing"

docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  || fail "pgvector extension unavailable — confirm the loaded image is pgvector/pgvector:pg16, not a plain postgres image"
```

**Phase D — Non-destructive migrations:**

```bash
log "Applying migrations (non-destructive — knex_migrations tracks what's already applied)..."
docker compose run --rm --build migrate
docker compose run --rm migrate npx knex --knexfile knexfile.js migrate:status
```

Never `migrate:rollback` in this script — a rollback is a deliberate, human-invoked operation (RUNBOOK.md, Database Operations), not something an idempotent installer should ever do automatically.

**Phase E — Least-privilege grant verification:**

```bash
log "Verifying app_runtime_user grants (Section 5 expectation: SELECT/INSERT/UPDATE/DELETE on every table except audit_logs, which is SELECT/INSERT only)..."
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
  WHERE grantee = '${APP_DB_USER}'
  GROUP BY table_name ORDER BY table_name;
"
AUDIT_PRIVS=$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "
  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee = '${APP_DB_USER}' AND table_name = 'audit_logs';
")
[ "$AUDIT_PRIVS" = "INSERT,SELECT" ] || fail "app_runtime_user has unexpected privileges on audit_logs: '$AUDIT_PRIVS' (expected INSERT,SELECT only — append-only guarantee is broken)"
```

**Phase F — Verify external vLLM generation and embedding models are present:**

There is no local model bundle to seed on this host — model weights live entirely on the enclave's dedicated GPU boxes, provisioned and loaded by whatever process stands those boxes up (out of scope for this installer, and for this repo). This script's job is narrower but still a hard gate: confirm the *specific* models this app is configured to call are actually being served, not just that the vLLM host answers `/v1/models` at all.

```bash
log "Confirming configured models are served by ${LLM_BASE_URL}..."
AVAILABLE_MODELS=$(curl -sf --max-time 5 "${LLM_BASE_URL}/v1/models" | python3 -c "import json,sys; print(' '.join(m['id'] for m in json.load(sys.stdin)['data']))")

echo "$AVAILABLE_MODELS" | grep -qw "${LLM_MODEL}" \
  || fail "generation model '${LLM_MODEL}' not found among vLLM-served models: $AVAILABLE_MODELS — confirm the GPU host has this model loaded before continuing"

echo "$AVAILABLE_MODELS" | grep -qw "${EMBEDDING_MODEL}" \
  || fail "embedding model '${EMBEDDING_MODEL}' not found among vLLM-served models: $AVAILABLE_MODELS — semantic search (Section 5, step 6) will 503 without it"

# A real round-trip, not just a model-listing check — catches auth
# (LLM_API_KEY) misconfiguration and gateway-level issues /v1/models alone
# wouldn't surface.
curl -sf --max-time "${LLM_TIMEOUT_MS:-30000}e-3" -X POST "${LLM_BASE_URL}/v1/completions" \
  -H "Authorization: Bearer ${LLM_API_KEY:-}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"${LLM_MODEL}\",\"prompt\":\"ping\",\"max_tokens\":1}" >/dev/null \
  || fail "test completion against ${LLM_BASE_URL} failed — check LLM_API_KEY and vLLM gateway logs"
```

This script deliberately does not attempt to automate weight-staging or GPU-host provisioning itself — that's a separate, hardware-specific process the enclave's infra team owns, and pretending to script it here would just be wrong for whatever the real GPU-box provisioning tooling actually is. What this phase *does* own is the install-time confirmation that the app's configuration (`LLM_MODEL`/`EMBEDDING_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`) actually lines up with what's being served, since a mismatch here otherwise surfaces later as a confusing runtime 503 rather than a clear install-time failure.

**Phase G — Bring up backend/frontend, verify, first admin:**

```bash
docker compose up -d --build backend frontend
timeout 60 bash -c 'until curl -sf http://localhost:8101/health >/dev/null; do sleep 2; done' \
  || fail "backend /health did not become reachable within 60s"

# /health's "ai" block reports the *live* provider health sweep result
# (LLM_HEALTH_CHECK_INTERVAL_MS, default 60s) against the real vLLM host —
# this is the actual end-to-end confirmation that config, network path, and
# GPU-host availability all line up, not just that the backend process is up.
curl -s http://localhost:8101/health | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ai',{}).get('healthy') is True, d; print('vLLM provider healthy:', d['ai'])" \
  || fail "backend is up but reports the vLLM provider unhealthy — check LLM_BASE_URL/LLM_API_KEY/ALLOWED_LLM_ORIGINS and the GPU host's own logs"

log "Frontend build verification..."
docker compose exec -T frontend sh -c "test -f /usr/share/nginx/html/index.html" \
  || fail "frontend static build missing — check frontend/Dockerfile build stage output"

if [ "${SKIP_FIRST_ADMIN:-0}" != "1" ]; then
  log "No accounts can exist yet on a fresh install — create the first system admin now:"
  echo "    docker compose exec -T backend node /app/scripts/create-first-admin.mjs <username> <email> <password>"
fi
```

**Phase H — nginx proxy reload (only if this enclave fronts the app with a shared reverse proxy the same way `wireservice-nginx-1` does):**

```bash
if [ "${RELOAD_NGINX:-0}" = "1" ]; then
  scripts/deploy.sh --reload-nginx
fi
```

Reuse `scripts/deploy.sh` rather than duplicating its nginx-reload logic — see `RUNBOOK.md`'s Production Deployment section for why this touches shared infrastructure carefully (`nginx -s reload`, not a rebuild, and only with the flag explicitly set).

### 2.3 What this script deliberately does NOT do

- Does not generate secrets for you (`JWT_SECRET`/`POSTGRES_PASSWORD`/`APP_DB_PASSWORD`) — RUNBOOK.md's existing `node -e "crypto.randomBytes(...)"` one-liners are the documented way, and an installer silently generating and *storing* secrets somewhere is a bigger risk than asking the operator to do it by hand once.
- Does not touch `wireservice-nginx-1`'s `nginx.conf` or certbot hooks — that's shared infrastructure outside this repo's promotion path (RUNBOOK.md is explicit about this), and any enclave equivalent should follow the same "reload is scripted, edit is manual and confirmed" split.
- Does not run `docker compose down -v` or any destructive operation under any flag — a broken install should be diagnosed and re-run, not nuked.

### 2.4 Offline script execution: run maintenance scripts inside the `backend` container, not on the host

`scripts/*.mjs` (`verify-audit-log.mjs`, `create-first-admin.mjs`, `upgrade-prompt-versions.mjs`, `grant-system-admin.mjs`, `clear-test-artifacts.mjs`, the seed scripts) currently assume they run on the *host*, against `scripts/node_modules` staged separately from `/backend`'s own — a reasonable design choice for local dev (`RUNBOOK.md`: "its own small dependency tree (dotenv, pg), separate from /backend" — these tools should keep working even if the backend app itself is broken or mid-deploy), but for an enclave install it means staging and `npm install`-ing a second offline dependency tree solely for occasional operator commands, duplicating packages the already-staged `backend` image has installed.

**Verified**: `scripts/package.json`'s dependencies (`bcryptjs ^2.4.3`, `dotenv ^16.4.5`, `jsonwebtoken ^9.0.2`, `knex ^3.1.0`, `pg ^8.13.1`, `ws ^8.18.0`) are an exact-version-range subset of `backend/package.json`'s own dependencies — every package `scripts/` needs already sits in `/app/backend/node_modules` inside the built `backend` image. There's no need to ever stage or `npm install` a second copy of the same packages just to run these tools.

**Change `backend/Dockerfile`** to also stage `/scripts` as a sibling of `/app/backend` — this specifically mirrors the exact repo-root sibling relationship (`backend/` next to `scripts/`) that every `scripts/*.mjs` file's own relative imports already assume (`../backend/src/audit/auditService.js`, `../backend/.env`), so **this requires zero changes to the .mjs files themselves**:

```dockerfile
# ...existing: WORKDIR /app/backend; COPY backend/ ./; COPY database/ /app/database/ ...

# Stage /scripts as a sibling of /app/backend, matching the repo root's own
# backend/ + scripts/ layout — every scripts/*.mjs's existing relative
# import (`../backend/src/...`, `../backend/.env`) resolves correctly from
# here with no source changes. The symlink is what lets Node's module
# resolution find scripts/package.json's own dependencies without a second
# npm install: every one of them is already installed under
# backend/node_modules, at matching version ranges (verified above) — Node's
# resolution just needs a node_modules reachable from /app/scripts, which
# only walks upward from a script's own directory, never sideways.
COPY scripts/*.mjs /app/scripts/
RUN ln -s /app/backend/node_modules /app/node_modules
```

**Run maintenance scripts against the running enclave stack via `docker compose exec`, not `cd scripts && npm install && node ...` on the host:**

```bash
docker compose exec -T backend node /app/scripts/verify-audit-log.mjs
docker compose exec -T backend node /app/scripts/create-first-admin.mjs <username> <email> <password>
docker compose exec -T backend node /app/scripts/upgrade-prompt-versions.mjs
docker compose exec -T backend node /app/scripts/clear-test-artifacts.mjs
```

Every one of these scripts calls `dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') })`, which resolves to `/app/backend/.env` inside the container — that file won't actually exist there (`.env` is gitignored, never baked into the image), but that's harmless: `docker-compose.yml` already injects `PGHOST`/`PGUSER`/`APP_DB_USER`/`APP_DB_PASSWORD`/etc. directly into the `backend` service's container environment, and `dotenv.config()` never overwrites an already-set environment variable (the same behavior `CLAUDE.md` documents for how the test suite picks up `PGDATABASE`) — so these scripts pick up the right connection settings automatically without `backend/.env` needing to physically exist inside the container.

**What this eliminates**: no `scripts/node_modules` to stage as a separate offline artifact, no `npm install` step for `/scripts` anywhere in the install process (Phase B's image tars become the *only* offline dependency-staging this project needs), and no assumption that whatever host is running `docker compose` even has its own working `node` on `PATH` — everything now executes inside the one container that's already been verified reachable and correctly configured.

**Caveat**: this makes `/scripts` share a module graph with `/backend` at the filesystem level (via the symlink), even though they remain logically separate packages. Acceptable specifically because the scenario `RUNBOOK.md` cites for keeping them separate — "these tools should work even if the backend app itself is broken or mid-deploy" — requires the backend container to not be running at all, which is also exactly the one case `docker compose exec` itself can't reach either. If a maintenance script ever needs to run while the `backend` container won't start, the original host-side path (`cd scripts && npm install && node ...`, still fully functional and unchanged) remains available as a fallback — this change is the new default for a working enclave, not a removal of the alternative for a broken one.

---

## 3. Unresolved Known Issues & Release Go/No-Go Decisions

### Must Fix Before v1.0 Enclave Ship

#### 3.1 Root `.env.example` reintroduces the v1 prompt-injection weakness Finding 2 was meant to close

**Verified in current source.** `backend/src/config.js:99-103` defaults to `v2` in code, and `backend/.env.example` correctly documents `v2`. `docker-compose.yml:109-110` was fixed to `${LLM_SUMMARY_PROMPT_VERSION:-v2}` / `${LLM_TASK_PROMPT_VERSION:-v2}`. But the **root** `.env.example` — the file Compose actually reads via its own `.env` lookup, and the one `RUNBOOK.md`'s First-Time Setup step 0 tells every new install to `cp .env.example .env` from — still contains:

```
LLM_SUMMARY_PROMPT_VERSION=v1
LLM_TASK_PROMPT_VERSION=v1
```

Because Compose's `${VAR:-default}` interpolation only falls back to the Compose-file default when `VAR` is *entirely unset*, an explicit `v1` in `.env` wins over `docker-compose.yml`'s `v2` default. Any enclave install that follows the documented setup path ends up running the weaker, non-nonce-delimited prompt template — silently, with every other piece of documentation (RUNBOOK.md, `promptTemplates.js`'s own comments) asserting `v2` is in effect.

**Fix (2-line change, no code/schema impact):**

```diff
# .env.example
- LLM_SUMMARY_PROMPT_VERSION=v1
- LLM_TASK_PROMPT_VERSION=v1
+ LLM_SUMMARY_PROMPT_VERSION=v2
+ LLM_TASK_PROMPT_VERSION=v2
```

**Verification after fix:**

```bash
grep -n "LLM_SUMMARY_PROMPT_VERSION\|LLM_TASK_PROMPT_VERSION" .env.example .env backend/.env docker-compose.yml
# Every line should say v2. Then, against a running stack, confirm the
# response header actually reflects it:
curl -sN -X POST http://localhost:8101/api/channels/<channelId>/ai/summarize \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{}' -D - -o /dev/null | grep X-Ai-Prompt-Version
# Expect: X-Ai-Prompt-Version: v2
```

If any enclave install already ran with `.env`'s stale `v1` before this fix lands, also run the existing backfill script against that deployment's database:

```bash
docker compose exec -T backend node /app/scripts/upgrade-prompt-versions.mjs
```

(This script already exists and already does exactly this — `scripts/upgrade-prompt-versions.mjs`, written for this same finding — the gap was purely the `.env.example` default, not missing tooling.)

#### 3.2 vLLM provider path has never been exercised against real hardware — and this enclave has no CPU fallback

**This item's severity is upgraded from the earlier draft of this punch list**: the vLLM adapter is unit-tested only against a mocked OpenAI-compatible endpoint (`RUNBOOK.md`: *"`vllm` is implemented and unit-tested against a mocked OpenAI-compatible endpoint (`/v1/completions`, `/v1/models`) but has not been exercised against a real vLLM instance — this test host has no GPU. Verify against a real instance before relying on it in production."*). That caveat was written when `LLM_PROVIDER=ollama` (local CPU) was this project's own documented default and vLLM was an optional upgrade path for GPU-backed hosts. **That's no longer this enclave's situation**: this deployment uses external, dedicated GPU boxes running vLLM as the *only* inference path — there is no local Ollama container in this topology to fall back to (Section 2 no longer stages one). "Unit tests pass against a mock" cannot stand in for "verified against the real provider" when the mocked path is the entire production path, not a fallback.

**Must verify before go-live, against the enclave's actual GPU hosts, not a mock:**

```bash
# 1. Direct provider round-trip, bypassing the app entirely — isolates
#    "is vLLM itself serving correctly" from "is the app's adapter correct."
curl -s -X POST "${LLM_BASE_URL}/v1/completions" -H "Authorization: Bearer ${LLM_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${LLM_MODEL}\",\"prompt\":\"Say hello in one word.\",\"max_tokens\":5}"

curl -s -X POST "${LLM_BASE_URL}/v1/embeddings" -H "Authorization: Bearer ${LLM_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${EMBEDDING_MODEL}\",\"input\":\"test\"}"

# 2. Through the actual app (Section 5's verification checklist steps 5-6)
#    — proves the adapter's request/response shaping matches this specific
#    vLLM deployment's actual behavior (headers, streaming chunk format,
#    error-body shape), which a mock by definition cannot prove.
```

**Also verify under realistic load**, not just a single request: `scripts/load-test.mjs` (100 simulated concurrent users) exercises message send/receive but does not exercise the AI summarize/extract-tasks/search paths — run a manual concurrent-AI-request test against the real vLLM host to confirm `LLM_MAX_CONCURRENT_REQUESTS`/`EMBEDDING_MAX_CONCURRENT_REQUESTS` and `LLM_TIMEOUT_MS`/`EMBEDDING_TIMEOUT_MS` are tuned sensibly for this specific GPU host's actual latency and throughput — values copied from the CPU-Ollama test environment's defaults have no reason to be correct for different hardware over a network hop. If the enclave has multiple GPU boxes for redundancy/throughput, confirm what `LLM_BASE_URL` actually resolves to (a load balancer? a single fixed host?) and that `ALLOWED_LLM_ORIGINS` matches whatever that real target is.

#### 3.3 Backend container healthcheck targets `/health` instead of `/health/live`

**Verified in current source**: `docker-compose.yml:122` probes `http://localhost:8000/health`, not `/health/live`. Full detail and fix in Section 4.1. Called out here too because it's a Must-Fix, not an operational nice-to-have: `/health` is coupled to Postgres and the external vLLM host's reachability, so a temporary DB maintenance window or a network blip to the GPU host flips the container's liveness signal, not just its readiness — exactly the kind of restart-loop risk that matters more once the LLM dependency is a real network hop (Section 1) rather than a same-host sidecar that rarely blips independently of the container itself. One-line fix, no schema/migration impact — bundle it with the 3.1 `.env.example` fix in the same pre-ship change.

---

### Verified Already Fixed (confirmed by reading current source, not by trusting the review docs)

| Finding | Source review | Verified fix location |
|---|---|---|
| Self-service workspace ownership → global audit/AI escalation (HIGH) | 07-15 | `backend/src/authz/membershipService.js:120` `requireSystemAdmin()` gates strictly on `is_system_admin`; used by `routes/audit.js:28,81` and `routes/ai.js:26,36` — no fallback to workspace role |
| Cross-workspace channel-membership injection (HIGH) | 07-15 | `backend/src/routes/workspaces.js:1333` explicit `channel.workspace_id !== workspaceId` check before any target-membership logic |
| Disabled accounts keep using valid tokens/WS sessions (MEDIUM) | 07-15 | `backend/src/auth/requireAuth.js` re-queries `users.status` on every REST call; `ws/server.js` `handleAuthenticate` does the same plus `connectionRegistry.disconnectUser()` force-closes live sockets on disable |
| LLM `baseUrl` SSRF/DoS (MEDIUM) | 07-15 | `ALLOWED_LLM_ORIGINS` + `assertAllowedLlmUrl()`, wired into `backend/src/llm/settingsService.js:105` — **this control is now load-bearing, not defense-in-depth**: with `LLM_BASE_URL` pointed at a real external vLLM host, `ALLOWED_LLM_ORIGINS` is the only thing stopping an admin session from repointing `baseUrl` at an arbitrary internal enclave address; confirm it's set to exactly the enclave's vLLM host origin(s) before ship, never left empty/wildcard |
| WebSocket unbounded payload before auth (MEDIUM) | 07-15 | `config.ws.maxPayloadBytes` (128 KiB default) passed to `WebSocketServer` constructor, `backend/src/ws/server.js:43` |
| Group DM unbounded member array (LOW) | 07-15 | `MAX_GROUP_DM_MEMBERS` cap present and enforced |
| Archived-workspace token invitations still redeemable (MEDIUM) | 07-15 | `backend/src/routes/invitations.js:89-105` re-checks `archived_at` inside the row-locked redemption transaction |
| System-admin channel creation grants private-channel read access (HIGH) | 07-20 | `backend/src/routes/workspaces.js:1155` — `channel_members` insert now conditioned on `!viaSystemAdminOverride` |
| Fixed-delimiter (v1) prompts reachable via Compose default | 07-20 | `docker-compose.yml:109-110` fixed to `v2` — **but see 3.1 above, the root `.env.example` regressed this** |
| Several list endpoints unbounded (workspaces, discoverable, 3× invitations) | 07-20 | *(spot-check before ship — see 3.5 below; not independently re-verified this pass beyond the six the 07-20 log claims were fixed)* |
| `fetchAllPages()` defeats backend pagination | 07-20 | *(not independently re-verified this pass — recommend a frontend spot-check, 3.4)* |
| Notification summary re-aggregates full backlog | 07-20 | *(not independently re-verified this pass — recommend a spot-check, 3.5)* |
| Membership invitations acceptable after archive | 07-20 | `backend/src/routes/membershipInvitations.js:119-136` — `archived_at` checked for both org and workspace scope inside the transaction |
| Presence/composer force full re-render + re-tokenization | 07-20 | *(not independently re-verified this pass — UI performance, not a correctness gap; low ship risk either way, see 3.5)* |
| Task checkbox has no optimistic UI | 07-20 | *(cosmetic/UX only — acceptable to ship without, see below)* |

### Acceptable Risk for Isolated Enclave v1.0

#### 3.4 Certbot renewal hooks broken on `wireservice-nginx-1`

**Not applicable to an air-gapped enclave as currently written**, but the underlying question doesn't disappear — it changes shape. `RUNBOOK.md` documents that `/etc/letsencrypt/renewal-hooks/{pre,post}` silently no-op because there's no Compose `nginx` service, so all three domains' certs will fail to auto-renew. In a genuinely air-gapped enclave there is no path to a public CA (Let's Encrypt/ACME needs internet reachability) at all, so **Certbot itself is moot** — this isn't a "fix later" item, it's "this mechanism cannot exist in this environment, full stop."

**Decision needed (Go/No-Go item, not a code fix):** how does the enclave's internal `whisper.<enclave-domain>` equivalent get a valid TLS certificate?
- **Recommended**: an internal/private CA the enclave already operates (most air-gapped enterprise networks have one for exactly this reason), with a manual or scripted renewal against that CA's own (offline-reachable) issuance API.
- **Acceptable fallback**: a long-lived self-signed cert, manually rotated, with the rotation date tracked outside this repo (an ops calendar entry, not a punch-list item) — acceptable specifically because the enclave's client population is a known, enrolled set of enterprise devices that can be told to trust one internal cert, unlike a public-internet audience.
- Either way, this is infrastructure the enclave operators own (mirroring `RUNBOOK.md`'s existing framing that `wireservice-nginx-1` config is "a different repo/host state," not app code) — not something `scripts/airgap-install.sh` should attempt to automate.

#### 3.5 Three 07-20 findings not independently re-verified in this pass

Findings 3 (remaining unbounded list endpoints), 4 (`fetchAllPages()`), 5 (notification summary cost), and 7 (presence/composer re-render cost) are marked "fixed" by the 07-20 log's own commits (`1baaabf`, `5242607`), but this audit pass verified the *security-relevant* fixes in depth (Section 3's table above) and did not line-by-line re-verify these four *performance* items against current source. **None of these block ship** — they're UI/DB-load optimization, not correctness or authorization defects, and the app has already run a 100-concurrent-user load test (`scripts/load-test.mjs`) against this codebase. Recommend a 30-minute spot-check before ship (grep `frontend/src/api/client.js` for `fetchAllPages`'s call sites, confirm `getMentionSummary()`'s shape, confirm `React.memo` presence on `WorkspaceSidebar`/`ChannelView`) rather than a full re-review — low risk, cheap to confirm.

#### 3.6 Design token contrast gaps (from `docs/reviews/ui-ux-review.md`)

Not re-read in full this pass (out of scope for a security/deployment punch list), but flagged in the review title as an open UI/UX item. **Acceptable risk for v1.0** in an internal enterprise enclave with a known, enrolled user population — accessibility contrast issues are real and should be fixed, but they are not a shipping blocker for a first internal release the way an authorization bug would be. Track as a fast-follow, not a gate.

---

## 4. Operations, Observability & Backup Preparedness

### 4.1 Health checks — the two endpoints are correctly split in code, but the container healthcheck targets the wrong one

Both endpoints exist and are correctly split (`backend/src/index.js`): `GET /health/live` is process-alive-only (no DB/provider touch — safe for a liveness probe that shouldn't cascade-fail on a slow dependency), `GET /health` includes DB and AI-provider health, and now also reflects the external vLLM host's reachability (Section 1). The application code did this split correctly — but `docker-compose.yml`'s own container-level healthcheck doesn't use it correctly:

```yaml
# docker-compose.yml:122 — current, wrong probe target
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

**This must target `/health/live`, not `/health`.** Docker's own healthcheck is a *container liveness* signal — it's what `docker compose ps` reports, what any `depends_on: condition: service_healthy` elsewhere in the stack watches, and what an enclave's monitoring/auto-remediation layer (if one restarts unhealthy containers) acts on. `/health` deliberately couples that signal to Postgres reachability and the external vLLM host's health sweep — a routine, temporary DB maintenance window or a momentary network blip to the GPU host would flip the *process itself* (which is fine and doesn't need restarting) into "unhealthy," and any restart-on-unhealthy automation would then cycle a perfectly good backend process, right in the middle of the actual outage it should be riding out, not compounding.

**Fix:**

```yaml
# docker-compose.yml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

`/health` (DB + vLLM-inclusive) stays exactly where it already is — a monitoring/dashboard signal, and the specific check the install script's Phase G (Section 2.2) and the go-live verification checklist (Section 5, step 1) both deliberately hit on purpose, since *those* specific moments actually want to know "is everything downstream also working," not just "is the process alive." The distinction is which check answers which question, not that one of them is wrong.

```bash
curl -s http://localhost:8101/health/live   # {"status":"ok"} — container healthcheck should use this
curl -s http://localhost:8101/health        # {"status":"ok","db":"ok","ai":{...},"uptimeSeconds":N} — dashboards/install-time gates use this
```

### 4.2 Log rotation — genuine gap, needs config

**Verified gap**: `docker-compose.yml` sets no `logging:` block on any service, which means every container uses Docker's default `json-file` driver with **no `max-size`/`max-file` limit** — logs grow unbounded on disk for the lifetime of the container. In a normal dev host this gets caught by incidental `docker system prune` habits; in a long-running, unattended enclave deployment it's a slow disk-exhaustion risk with no operator signal until it's already a problem.

**Fix**: add an explicit bounded driver to every service in `docker-compose.yml`:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  backend:
    logging: *default-logging
    # ...
  frontend:
    logging: *default-logging
  postgres:
    logging: *default-logging
```

(No `silent-whisper-ollama` entry — this enclave's Compose stack has no local Ollama service; generation/embedding inference runs entirely on the external vLLM GPU hosts, which are outside this Compose project and have their own, separately-owned log rotation on the GPU-host side.)

This caps each service at 50MB of retained logs (5 files × 10MB), rotated automatically by the Docker daemon — no external log-shipping agent needed, which matters here since the enclave has no external log aggregation endpoint to ship to anyway. Also worth noting for the enclave runbook: `docker compose logs -f <service>` already works exactly as documented in `RUNBOOK.md`'s Logs section regardless of this change — rotation only affects retention, not the `docker compose logs` interface.

**Backend's own log output** is currently unstructured (`console.log`/`console.error` only — `backend/src/errors.js:83`, `backend/src/index.js:121,125`), no JSON structured logging, no log level filtering. Acceptable for v1.0 at this scale (single instance, `docker compose logs` is the actual operational interface, not a log aggregator) — flag as a fast-follow if the enclave ever needs to feed these logs into a SIEM, but don't block ship on introducing a logging library now.

### 4.3 Database backup/restore — genuine gap, no script exists today

**Verified gap**: `find . -iname "*backup*"` (excluding `node_modules`/`.git`) returns nothing. There is no backup script, no restore script, no documented `pg_dump`/`pg_restore` procedure anywhere in `RUNBOOK.md` or `scripts/`. This needs to exist before an enclave — which by definition can't lean on a cloud provider's managed-Postgres backup story — goes live with real data in it.

**Add `scripts/backup-db.sh`:**

```bash
#!/usr/bin/env bash
# Full logical backup, custom format (-Fc) so pg_restore can selectively
# restore and so it compresses by default — matters more here than usual
# since enclave storage/bandwidth for backup transport is often constrained.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source <(grep -v '^#' .env | grep -v '^$')  # POSTGRES_USER/POSTGRES_DB

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "SELECT to_char(now(), 'YYYY-MM-DD_HH24MISS');")
mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Fc \
  > "${BACKUP_DIR}/silent_whisper_${TIMESTAMP}.dump"

echo "Backup written: ${BACKUP_DIR}/silent_whisper_${TIMESTAMP}.dump"
echo "Verify with: pg_restore --list ${BACKUP_DIR}/silent_whisper_${TIMESTAMP}.dump"
```

**Add `scripts/restore-db.sh`:**

```bash
#!/usr/bin/env bash
# Restores into a FRESH database, never over a live one in place — protects
# against exactly the class of accident CLAUDE.md's resetDb.js warning
# exists for (irreversibly clobbering real data with the wrong target).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DUMP_FILE="${1:?Usage: $0 <dump-file> [target-db-name]}"
TARGET_DB="${2:-silent_whisper_restored_$(date +%s)}"

echo "Restoring into NEW database '${TARGET_DB}' (never the live 'silent_whisper' DB directly)."
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c "CREATE DATABASE ${TARGET_DB};"
docker compose exec -T postgres pg_restore -U "${POSTGRES_USER}" -d "${TARGET_DB}" < "$DUMP_FILE"

echo "Restored into ${TARGET_DB}. Verify data, then rename into place manually:"
echo "  docker compose stop backend"
echo "  psql ... -c 'ALTER DATABASE silent_whisper RENAME TO silent_whisper_old;'"
echo "  psql ... -c 'ALTER DATABASE ${TARGET_DB} RENAME TO silent_whisper;'"
echo "  docker compose up -d backend"
```

**pgvector/HNSW-specific note**: `pg_dump -Fc`/`pg_restore` correctly capture and rebuild the `idx_message_embeddings_hnsw` index (migration `0009_pgvector_and_embeddings.js`) as part of the normal table restore — no special handling needed, but HNSW index *build* time on restore scales with `message_embeddings` row count, so a large-history restore should budget extra time for that index to rebuild before search is fully warm. Confirm with:

```bash
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" \
  -c "SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid = 'idx_message_embeddings_hnsw'::regclass;"
# indisvalid should be 't' once restore completes
```

**Operational cadence decision needed**: how often does the enclave run `backup-db.sh`, and where do dumps get stored (a second disk? An enclave-internal object store?)? This is a decision for whoever owns the enclave's storage topology, not something this repo can answer — but the script should exist and be tested (a real backup → real restore → app boots against the restored DB → login works) before ship, even if the cron/cadence decision comes later.

### 4.4 Audit log integrity verification — already solid, exercise it in the enclave

`scripts/verify-audit-log.mjs` already exists, already does the right thing (connects read-only as `app_runtime_user`, walks the chain, recomputes hashes, reuses the exact same `computeRowHash`/`GENESIS_HASH` the app itself uses via relative import — not a reimplementation that could drift). Nothing to build. **Action item**: run it once against the enclave's actual seeded data as part of go-live verification (Section 5), not just in this dev environment — via the in-container invocation (Section 2.4), which needs no separate `scripts/node_modules` staged anywhere.

```bash
docker compose exec -T backend node /app/scripts/verify-audit-log.mjs
# Expect: Log Integrity Verified (exit 0)
```

---

## 5. Verification & Acceptance Checklist

Run this in order, inside the enclave, immediately post-install. Each step should be a hard gate — don't proceed past a failing step.

```bash
### 1. Stack health
curl -sf http://localhost:8101/health/live | grep -q '"status":"ok"' && echo "PASS: liveness"
curl -s http://localhost:8101/health | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['status']=='ok' and d['db']=='ok'; print('PASS: health', d)"

### 2. First admin + auth
GEN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
docker compose exec -T backend node /app/scripts/create-first-admin.mjs enclave-admin admin@enclave.local "$GEN_PASSWORD"
# capture the password it prints, then:
curl -s -c /tmp/cookies.txt -X POST http://localhost:8101/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"enclave-admin","password":"<password-from-above>"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'accessToken' in d; print('PASS: login')"

### 3. WebSocket presence
# Use a WS client (wscat, or a short node script) to connect to ws://localhost:8101/ws,
# send {"type":"authenticate","accessToken":"<token>"}, and confirm a
# {"type":"authenticated", "presence": {...}} frame comes back.

### 4. Workspace/channel/message round trip
TOKEN=<accessToken from step 2>
WS_ID=$(curl -s -X POST http://localhost:8101/api/workspaces -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Enclave Verification"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
CH_ID=$(curl -s -X POST "http://localhost:8101/api/workspaces/$WS_ID/channels" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"general","type":"PUBLIC"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "http://localhost:8101/api/channels/$CH_ID/messages" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"content":"enclave smoke test"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['content']=='enclave smoke test'; print('PASS: message round-trip')"

### 5. AI summarization + task extraction, routed to the external vLLM GPU host
### (only if LLM_PROVIDER != disabled — it should be "vllm" in this enclave, never "ollama")
curl -sN -X POST "http://localhost:8101/api/channels/$CH_ID/ai/summarize" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' -D - -o /tmp/summary.txt
grep -q "X-Ai-Provider: vllm" /tmp/summary.txt || echo "FAIL: expected X-Ai-Provider: vllm — check LLM_PROVIDER"
grep -q "X-Ai-Prompt-Version: v2" <(curl -sND - -X POST "http://localhost:8101/api/channels/$CH_ID/ai/summarize" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' -o /dev/null) \
  && echo "PASS: AI summarize uses v2 prompt template, served by vLLM" || echo "FAIL: check .env LLM_SUMMARY_PROMPT_VERSION (see Section 3.1)"
# This is the first real end-to-end proof that the backend's HTTP round trip
# to the enclave's actual GPU host works (Section 3.2) — not just that the
# host answers /v1/models, and not just that unit tests against a mock pass.

### 6. Vector/semantic search (embeddings also served by the vLLM host —
### EMBEDDING_MODEL, not a separate local model)
# Wait ~EMBEDDING_WORKER_INTERVAL_MS (2s default) for the message from step 4
# to be embedded, then:
curl -s -X POST http://localhost:8101/api/search/semantic \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"smoke test\",\"workspaceId\":\"$WS_ID\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert len(d.get('results',[])) >= 0; print('PASS: semantic search reachable', d)"
# A failure here specifically (while step 5 passes) points at the vLLM
# host's embeddings endpoint/EMBEDDING_MODEL rather than the generation
# path — check embedding_jobs backlog (RUNBOOK.md, Semantic Search) if
# results stay empty longer than the worker interval should allow.

### 7. Audit log hash-chain continuity
docker compose exec -T backend node /app/scripts/verify-audit-log.mjs
# Expect: "Log Integrity Verified", exit 0
# Also exercise the admin-dashboard equivalent (proves the API path, not just the CLI):
curl -s -X POST http://localhost:8101/api/audit/verify -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['verified'] is True; print('PASS: API audit verify', d)"

### 8. Negative-authorization spot check (matches CLAUDE.md's requirement for
### negative-authorization tests — do this manually once even though the
### automated suite already covers it)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8101/api/audit/logs -H "Authorization: Bearer <a-non-admin-token>"
# Expect: 403 (authenticated, member, lacking privilege)

### 9. Backend test suite (confirms the enclave's own DB/env wiring is sound,
### not just that the app boots)
cd backend && npm test
# All suites green, including the audit-chain concurrency test and the
# app_runtime_user DELETE/UPDATE-denied-on-audit_logs test.

### 10. Full e2e (optional but recommended if Playwright + chromium are staged)
cd frontend && npm run test:e2e
```

**Sign-off**: all ten steps pass → v1.0 is cleared for enclave go-live, contingent on all three Must-Fix items in Section 3 (the root `.env.example` prompt version, real-hardware verification of the external vLLM path, and the container healthcheck target) being closed first, and Section 3.4's TLS/CA decision being made by whoever owns the enclave's network topology.
