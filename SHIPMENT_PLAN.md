# Silent Whisper v1.0 — Integrated Enclave Shipment Plan

Merges `SHIPMENT_PUNCHLIST.md` (mine, 2026-07-21) with `SHIPMENT_PUNCHLIST_REVIEW.md` (third-party, 2026-07-21). Where they agreed, that's the plan. Where they conflicted, I re-verified against current source (cited below) and this document states the resolution. Nothing here is aspirational — every item is either a concrete diff, a concrete script, or a concrete decision someone needs to make.

**Bottom line**: the reviewer's central correction stands and changes the Go/No-Go. My punchlist verified the *application* is hardened and enclave-appropriate (auth, authz, audit chain, rate limits, LLM adapters). It did not verify that **this repo can currently be packaged and installed into an air-gapped enclave at all** — and it can't, yet. `docker-compose.yml` is the shared-host Silent Lattice topology (Ollama sidecar, external `wireservice_default` network, `build:` directives, build-time-baked frontend URLs), not an enclave artifact. The application is close to ready; the shipment isn't. Section 1 is the new blocking work; everything the original punchlist called "must fix" is still must-fix, just no longer sufficient on its own.

**Revised Go/No-Go: No-Go until Section 1 (enclave packaging) and Section 2 (Must-Fix code/config items) are both done, and Section 3 (real vLLM hardware test) has run at least once.**

---

## How this document is maintained

This is a living plan, not a one-time report — treat it the way `FEATURE_REQUEST.md` treats its backlog (Status field + dated Done log) and `PROJECT_PLAN.md` treats Section 11 (append-only Implementation Log): update it in place as work happens, never let it silently drift out of sync with the repo.

**At the start of any session touching enclave shipment work**: read `## Progress tracker` below first — it's the fast, at-a-glance read of what's done, in progress, blocked, or not started. Don't assume the numbered sections below it (1.x, 2.x, 4, 5) reflect current reality on their own; they're the specs for the work, not the status of it. If a tracker row says "Done," the corresponding section's *fix* is real, but re-verify against source before relying on it for anything downstream (same "don't trust a stale claim" discipline this document itself was written to enforce on the original punchlist).

**Whenever an item from this plan gets done (fully or partially), update all three of these in the same pass — they're one edit, not three separate optional ones:**
1. **`## Progress tracker`** — flip that row's Status (`Not started` → `Partial` or `Done`), fill in the Date column, and add a short Notes entry if anything went beyond or short of the original spec.
2. **The relevant numbered section** (e.g. `### 2.1`) — add or update a `**Status: ...**` line right under its header, so someone reading that section in isolation doesn't miss that it's already resolved.
3. **`## 5. Final pre-ship checklist`** — check the box (`- [x]`), with a short inline note if the fix differed from what the checklist originally described.
4. **`## 6. Progress log`** at the bottom — append a new dated entry (newest at the bottom) with the actual detail: what changed, what was verified, what's still open, and anything discovered along the way that wasn't in the original plan. This is where the *why* and *how* live — the tracker table and checklist are just pointers into this log, not a replacement for it.

Status values to use consistently in the tracker: `Not started`, `Partial` (some but not all of an item's sub-parts done — say which), `Done`, `Blocked` (say what it's blocked on — e.g. needing real GPU hardware, or an enclave operator's decision).

---

## Progress tracker

One row per actionable item below. Update the **Status**/**Date** columns as work lands — this table is the fast at-a-glance read; `## 6. Progress log` at the bottom has the dated detail on each entry, same split as `FEATURE_REQUEST.md`'s Status field vs. its Done section.

| # | Item | Status | Date | Notes |
|---|---|---|---|---|
| 1.1 | `docker-compose.enclave.yml` override | Not started | | |
| 1.2 | Versioned/checksummed offline image contract | Not started | | |
| 1.3 | Rewrite `scripts/airgap-install.sh` | Not started | | |
| 1.4 | Enclave TLS/reverse-proxy decision | Not started | | Decision, not code — blocked on whoever owns the enclave's network topology |
| 2.1a | `.env.example` `v1`→`v2` prompt-version fix | **Done** | 2026-07-22 | |
| 2.1b | Remove dead `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN` placeholders | **Done** | 2026-07-22 | |
| 2.1c | Reconcile root `.env.example` with `backend/.env.example` | **Done** | 2026-07-22 | Went beyond the original item: also wired the 10 new keys into `docker-compose.yml`'s backend `environment:` block and added the matching `VITE_TASK_OWNER_TOKEN_ALIAS` frontend build arg — without that, setting them in root `.env` would have been silently ignored. `.env.enclave.example` itself still not created. |
| 2.2 | Backend healthcheck → `/health/live` | Not started | | |
| 2.3 | Ship `/scripts` inside backend image + test in a built container | Not started | | |
| 2.4 | vLLM real-hardware verification | Not started | | Needs access to real enclave/GPU hardware — external dependency, not just eng time |
| 2.5 | `backup-db.sh` / `restore-db.sh` | Not started | | |
| 2.6 | Docker log rotation | Not started | | |
| 2.7 | Grants-verification query fix | Partial | 2026-07-22 | Corrected query already landed in `RUNBOOK.md`'s "Check the `app_runtime_user` grants" section; the installer script that also needs it (`scripts/airgap-install.sh`) doesn't exist yet (1.3) |
| 4 | Installer shape (17 steps) | Not started | | Depends on 1.1–1.3 |

---

## 1. New blocking work: the enclave packaging gap (reviewer's Finding 1 — not in the original punchlist)

The original punchlist assumed "stage three image tars, write an installer" was sufficient. It isn't, because nothing in the current repo produces a Compose file or images shaped for an enclave. Verified against current source:

- `docker-compose.yml` backend service: `depends_on: silent-whisper-ollama: condition: service_started` — hard dependency on a service that must not exist in the enclave.
- Same file: `silent-whisper-ollama` and `ollama-pull-model` services are present and would be loaded/started by any install path that just runs `docker compose up`.
- `backend` and `frontend` both declare `networks: [default, wireservice_default]`, and `wireservice_default` is declared `external: true` — this network does not exist on a fresh enclave host and nothing creates it.
- `migrate`, `backend`, and `frontend` all use `build:` (context `.` or `./frontend`), not `image:`. `docker compose run --rm migrate` and `docker compose up -d --build backend frontend`, as both the punchlist and the current `CLAUDE.md` commands say, will try to `npm ci`/`npm install` at that moment — the opposite of "load offline tars and go."
- `frontend/Dockerfile` takes `VITE_API_URL`/`VITE_WS_URL` as build `ARG`s baked into the static bundle (confirmed: `ENV VITE_API_URL=$VITE_API_URL` before `RUN npm run build`). A frontend image built once in a networked staging environment is permanently pointed at whatever origin was used at build time — it cannot be repointed at a different enclave's hostname without rebuilding.

### 1.1 Action: add `docker-compose.enclave.yml`

An override (not a replacement — keep `docker-compose.yml` as the dev/Silent-Lattice-integrated file it already is and is documented to be) that:

- Drops `silent-whisper-ollama` and `ollama-pull-model` entirely, and drops backend's `depends_on` entry for it.
- Drops the `wireservice_default` network attachment on `backend`/`frontend` (the enclave has its own proxy story — see 1.4).
- Replaces every `build:` block with `image: silentwhisper-backend:<version>` / `silentwhisper-frontend:<version>` / same backend image for `migrate` (see 1.2 for the tagging contract).
- Keeps `postgres`'s existing `image: pgvector/pgvector:pg16` unchanged.
- Adds the `x-logging` block from Section 2.6 to `postgres`/`backend`/`frontend`.

```bash
docker compose -f docker-compose.yml -f docker-compose.enclave.yml config
```
should be run in the networked staging environment and the rendered output committed as a release artifact (reviewer's suggestion) — it's the only way to be sure the merge did what's intended before it's ever run for real on an offline host.

### 1.2 Action: a real, versioned offline image contract

Not "three tar files," a defined contract the installer can verify against:

```bash
# In the networked staging/build host, from a clean checkout at the release tag:
docker compose -f docker-compose.yml -f docker-compose.enclave.yml build backend frontend
docker tag <built-backend-image>  silentwhisper-backend:1.0.0
docker tag <built-frontend-image> silentwhisper-frontend:1.0.0

mkdir -p images
docker save pgvector/pgvector:pg16      -o images/postgres-pgvector-pg16.tar
docker save silentwhisper-backend:1.0.0  -o images/silentwhisper-backend-1.0.0.tar
docker save silentwhisper-frontend:1.0.0 -o images/silentwhisper-frontend-1.0.0.tar

sha256sum images/*.tar > images/CHECKSUMS.sha256
```

`docker-compose.enclave.yml` references the exact tags above (`silentwhisper-backend:1.0.0`, not `:latest`) — never rely on Compose's implicit project-derived image naming, which is what would let a stale locally-built image silently satisfy `image:` without ever being loaded from a tar. The installer (Section 1.3, Phase B) verifies the checksum file before `docker load`, and `docker image inspect` on the expected tag after — both currently missing from the punchlist's draft.

**Frontend build-time URL decision** — pick one, don't leave it implicit:
- **v1.0 (recommended, ships now)**: accept that the frontend image must be built once per enclave, with that enclave's final browser-facing URL baked in at staging-build time (`VITE_API_URL=https://<enclave-hostname>/api`). Document this explicitly in the runbook as a staging-time input, and have the installer verify the *built bundle actually contains* the expected origin (Section 1.3, uses the punchlist's own `grep dist/assets/*.js` idea, just pointed at the real enclave URL instead of `localhost`) rather than silently trusting that the right build args were used weeks earlier.
- **Fast-follow (not a v1.0 blocker)**: change `frontend/Dockerfile`/nginx to emit a small `/config.js` (or similar) generated from a runtime environment variable at container start, so one frontend image works across enclaves. Real, valuable simplification — don't let it block the current ship.

### 1.3 Action: rewrite `scripts/airgap-install.sh` against the corrected Compose file

The punchlist's draft has several bugs the reviewer caught; folding in the fixes rather than re-deriving them:

- **Load `.env` before referencing any variable from it.** The punchlist's Phase A checks `${LLM_PROVIDER:-}`/`${LLM_BASE_URL:-}` directly, which only works if the operator has separately `export`ed them — add `set -a; source .env; set +a` (or an equivalent safe loader) as the very first step of Phase A, before any `fail` check that references a `.env`-sourced variable.
- **Don't reach for `python3` after arguing against it.** The punchlist recommended Bash specifically to avoid adding Python as an enclave host dependency, then used `python3 -c "..."` for JSON parsing in Phases F/G and the verification checklist. Resolve the contradiction by doing the JSON parsing *inside the already-verified, already-running backend container* instead, which already has Node:
  ```bash
  docker compose exec -T backend node -e "
    const d = await (await fetch('http://localhost:8000/health')).json();
    if (!d.ai?.healthy) { console.error(JSON.stringify(d)); process.exit(1); }
    console.log('vLLM provider healthy:', JSON.stringify(d.ai));
  "
  ```
  This removes the last host-side dependency the script would otherwise need beyond `docker`, `curl`, and coreutils — no `python3` preflight to document, no shape-mismatch surprise from a `/v1/models` payload that doesn't look like what a hand-rolled `python3 -c` expects.
- **No `--build`, ever.** `docker compose run --rm --build migrate` and `docker compose up -d --build backend frontend` both must drop `--build` once `docker-compose.enclave.yml` uses `image:` — building was only ever a stand-in for "the image exists," and now it doesn't need to be, and *shouldn't be allowed to* (an accidental network build attempt inside the enclave should fail loudly, not silently succeed via image build). Add `-f docker-compose.yml -f docker-compose.enclave.yml` to every compose invocation in the script.
- **Fix the invalid timeout arithmetic.** `--max-time "${LLM_TIMEOUT_MS:-30000}e-3"` (Phase F) is not valid `curl` syntax. Replace with integer seconds: `--max-time "$(( (${LLM_TIMEOUT_MS:-30000} + 999) / 1000 ))"`.
- **Validate what the reviewer flagged as unvalidated**, each a real failure mode a "minimal tinkering" install would otherwise hit blind:
  - Built frontend bundle contains the expected `VITE_API_URL`/`VITE_WS_URL` origin (Section 1.2).
  - `CORS_ORIGIN` matches the actual browser-facing URL the operator configured.
  - `ALLOWED_LLM_ORIGINS` contains (or defaults to) exactly `LLM_BASE_URL`'s origin — this is the one thing standing between an admin session and SSRF into the enclave's internal network once `baseUrl` is admin-editable (already true today; more load-bearing once the approved target is a real network hop, per the original punchlist's Section 1.4).
  - `EMBEDDING_DIMENSION` matches what the configured `EMBEDDING_MODEL` actually returns — a mismatch here doesn't fail until the first semantic-search query, not at install time, without this check.
- **Preflight `curl`, `timeout`, `xargs` presence explicitly** rather than assuming they exist — cheap, and turns a cryptic mid-script failure into a clear one.
- **Write an install report.** `install-report-<timestamp>.txt`: git commit/tag, loaded image tags + digests, migration status, resolved (non-secret) env values with all `*_PASSWORD`/`*_SECRET`/`*_API_KEY` redacted, and pass/fail for every verification step. Costs little, and is the artifact an enclave operator actually wants to hand back to whoever signed off on the install.
- **Guided first-admin creation** (nice-to-have, not a gate): prompt for username/email/password interactively instead of only printing the raw `docker compose exec` command — closer to the "minimal tinkering" bar the reviewer is holding this to, cheap to add, skip if time-constrained.

### 1.4 Decision needed: enclave reverse-proxy / TLS model

Not a code fix — flagging because both documents' framing assumed the *existing* `wireservice-nginx-1` setup, which by definition doesn't exist in a customer's air-gapped enclave. Someone (enclave operator, most likely) needs to decide, before Phase H of the installer means anything:

- Does the enclave terminate TLS with its own reverse proxy in front of `frontend`/`backend` (most likely, matches how this app already expects to sit behind a proxy), or expose the containers' ports directly?
- Certificate source: an internal/private CA (recommended, matches the original punchlist's 3.4) or a long-lived self-signed cert with a tracked manual rotation date.
- If a proxy is used, its config (upgrade headers on `/ws`, `X-Forwarded-Proto`/`X-Forwarded-For` passthrough for `trust proxy: 1` and audit `actor_ip`) is the enclave's own artifact to write and own — this repo's installer should not attempt to generate it, only document the requirements (same "reload is scripted, edit is manual and confirmed" split `RUNBOOK.md` already uses for `wireservice-nginx-1`).

---

## 2. Must-Fix code/config items (both documents agree; consolidated, corrected)

### 2.1 Root `.env.example` — three separate problems, three separate fixes

**Status: Done (2026-07-22)** — all three parts below fixed; see `## 6. Progress log`. `.env.enclave.example` (the fourth, separate deliverable this section also calls for) is not yet created.

**a. The `v1`/`v2` prompt-version regression** (both documents' top item, independently verified in this pass): `backend/src/config.js` and `docker-compose.yml` both default to `v2`; root `.env.example` still says `v1` for both `LLM_SUMMARY_PROMPT_VERSION`/`LLM_TASK_PROMPT_VERSION`. Because Compose's `${VAR:-default}` only falls back when `VAR` is fully unset, following `RUNBOOK.md`'s own documented `cp .env.example .env` step silently resurrects the pre-fix, non-nonce-delimited prompt template.

```diff
# .env.example
- LLM_SUMMARY_PROMPT_VERSION=v1
- LLM_TASK_PROMPT_VERSION=v1
+ LLM_SUMMARY_PROMPT_VERSION=v2
+ LLM_TASK_PROMPT_VERSION=v2
```

If any environment already ran with the stale `v1` before this lands: `docker compose exec -T backend node /app/scripts/upgrade-prompt-versions.mjs` (already exists, already does this backfill).

**b. Delete the two dead placeholders** — `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN` are read nowhere in the codebase (confirmed by grep across `backend/src`, `frontend/src`, `scripts`, every `.yml`/`.sh`) and, in an enclave handoff specifically, a HuggingFace-token placeholder invites exactly the wrong question about whether this app fetches model weights at runtime (it doesn't).

**c. Root `.env.example` is missing keys `backend/.env.example` already has** — reviewer's addition, verified: `ALLOWED_LLM_ORIGINS`, `LLM_DIGEST_PROMPT_VERSION`, `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_MAX_CONCURRENT_REQUESTS`, `EMBEDDING_WORKER_INTERVAL_MS`, `EMBEDDING_WORKER_BATCH_SIZE`, `EMBEDDING_MAX_ATTEMPTS`, `AI_DIGEST_MAX_WINDOW_HOURS`, `TASK_OWNER_TOKEN_ALIAS`, `TASK_DASHBOARD_WINDOW_DAYS` are all real, live config knobs absent from the root file Compose actually reads. Reconcile this **and** create the enclave-specific template in the same pass:

- Update root `.env.example` to carry every key `backend/.env.example` defines (keeps local dev's single-`cp` workflow correct).
- Add `.env.enclave.example` as its own file: `LLM_PROVIDER=vllm`, `LLM_BASE_URL=<internal vLLM origin>`, `ALLOWED_LLM_ORIGINS=<same origin(s), exactly>`, real `LLM_MODEL`/`EMBEDDING_MODEL`/`EMBEDDING_DIMENSION` placeholders (not `mistral`/`all-minilm`, which are the Ollama defaults), `VITE_API_URL`/`VITE_WS_URL`/`CORS_ORIGIN` set to the enclave's real hostname placeholders, and **no** `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN` lines at all.

### 2.2 Backend container healthcheck targets `/health` instead of `/health/live`

Both documents agree on the fix; the reviewer's nuance is the correct framing and belongs in the fix's commit message: `backend/src/index.js:60` confirms `ai.healthy` never flips `/health`'s HTTP status code today (it's additive JSON only) — so the "vLLM blip causes a restart loop" risk is **not currently real**. The **DB-coupling** risk is real regardless (`/health` returns 503 on `checkDbConnection()` failure, and a routine Postgres maintenance window would trip a liveness-driven restart of an otherwise-fine process). Fix stands on that narrower, still-valid basis:

```yaml
# docker-compose.yml AND docker-compose.enclave.yml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

### 2.3 Ship `/scripts` inside the backend image — implement it, then prove it, don't just document it

Both documents agree this is the right design (avoids staging a second `scripts/node_modules` offline artifact — every dependency `scripts/package.json` needs is already an exact-version-range subset of `backend/package.json`'s, verified). The reviewer's correction is real: **this doesn't exist in `backend/Dockerfile` today** — implement, then test inside an actual built container before documenting it as the default:

```dockerfile
# backend/Dockerfile, after the existing COPY database/ line
COPY scripts/*.mjs /app/scripts/
RUN ln -s /app/backend/node_modules /app/node_modules
```

```bash
# Verification — run against a real built image, not asserted from reading the Dockerfile:
docker compose exec -T backend node /app/scripts/verify-audit-log.mjs
docker compose exec -T backend node /app/scripts/create-first-admin.mjs test-admin test@example.com "$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
docker compose exec -T backend node /app/scripts/upgrade-prompt-versions.mjs
```

Also fix the scripts' own error messages, which currently say the connection config is "expected in `backend/.env`" — true on the host, misleading in-container, where `dotenv.config()` finds no file and silently falls through to the already-injected Compose environment variables instead (this works correctly; only the error-message wording is stale). One-line message fix, not a logic change.

### 2.4 vLLM real-hardware verification (unchanged must-fix; reviewer's additions folded in)

Unit tests only exercise a mocked OpenAI-compatible endpoint; this enclave has vLLM as the *only* inference path, no CPU fallback. Both documents agree this is a hard gate. Full test matrix (reviewer added streaming, embedding-dimension, and concurrency to the original list):

```bash
# Direct provider round-trip, bypassing the app — isolates "vLLM itself"
# from "the app's adapter":
curl -s -X POST "${LLM_BASE_URL}/v1/completions" -H "Authorization: Bearer ${LLM_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${LLM_MODEL}\",\"prompt\":\"Say hello in one word.\",\"max_tokens\":5}"

curl -s -X POST "${LLM_BASE_URL}/v1/embeddings" -H "Authorization: Bearer ${LLM_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${EMBEDDING_MODEL}\",\"input\":\"test\"}"
# Confirm the returned embedding's length exactly equals EMBEDDING_DIMENSION —
# a mismatch here is a migration-shape problem (message_embeddings.embedding
# is a fixed vector(N) column) that won't surface until first semantic search.
```

- Streaming: hit `/api/channels/:id/ai/summarize` with `LLM_STREAMING_ENABLED=true` against the real host and confirm the SSE chunk format the adapter expects actually matches this vLLM deployment's real streaming behavior (a mock can't prove this).
- Auth: confirm `LLM_API_KEY` is actually honored (a wrong/missing key should fail cleanly, not silently succeed against an unauthenticated gateway).
- Through the app, not just the provider: summarize, task extraction, workspace digest, and semantic search (Section 5 of the original punchlist, steps 5–6).
- Under concurrency: manually fire several concurrent AI requests against the real GPU host and confirm `LLM_MAX_CONCURRENT_REQUESTS`/`LLM_TIMEOUT_MS` (copied from the CPU-Ollama test environment's defaults) are actually sane for this hardware over a real network hop — they have no reason to be correct un-tuned.

### 2.5 Backup / restore scripts — add them, harden per reviewer's specific corrections

Genuine gap (`find . -iname "*backup*"` returns nothing); both documents agree it must exist before real data goes into an enclave. Reviewer's two hardening notes are real bugs in the punchlist's draft, folded in:

**`scripts/backup-db.sh`** — same shape as the punchlist's draft, but don't parse `.env` with `source <(grep -v '^#' .env | grep -v '^$')` (breaks on any secret containing a shell-meaningful character — quotes, `$`, backticks). Use Compose's own already-parsed environment instead:

```bash
POSTGRES_USER=$(docker compose exec -T postgres printenv POSTGRES_USER)
POSTGRES_DB=$(docker compose exec -T postgres printenv POSTGRES_DB)
```

**`scripts/restore-db.sh`** — same shape, but validate the target DB name before it reaches SQL. The punchlist's draft interpolates `${TARGET_DB}` directly into `CREATE DATABASE ${TARGET_DB};`; add a strict allowlist check first:

```bash
TARGET_DB="${2:-silent_whisper_restored_$(date +%s)}"
[[ "$TARGET_DB" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || fail "invalid target database name: $TARGET_DB"
```

Test the **full loop**, not just that the scripts run: real backup → real restore into a fresh DB → point a backend instance at it → confirm login, message history, `verify-audit-log.mjs`, and semantic search all work → confirm `idx_message_embeddings_hnsw`'s `indisvalid = 't'` post-restore (HNSW rebuild time scales with `message_embeddings` row count — budget for it on a large-history restore).

Operational cadence (how often, where dumps are stored, retention, off-host copy) is the enclave operator's decision, not this repo's — the scripts existing and being proven correct is the actual gate.

### 2.6 Docker log rotation

Genuine gap, no disagreement: no `logging:` block anywhere in `docker-compose.yml`, so `json-file`'s default unbounded growth is live. Apply to `docker-compose.enclave.yml` (postgres/backend/frontend only — no Ollama entry in the enclave file at all, so nothing to add there):

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  postgres:
    logging: *default-logging
  backend:
    logging: *default-logging
  frontend:
    logging: *default-logging
```

### 2.7 Grants-verification query — fix the installer's oversimplified assumption

The punchlist's draft installer (its Phase E) asserts every table has `SELECT,INSERT,UPDATE,DELETE` except `audit_logs`. Verified against `database/migrations/0007_grants.js` and `0013_org_and_no_hard_delete_grants.js` — that assumption is wrong for **five** tables besides `audit_logs`:

| Table(s) | Actual grant | Why |
|---|---|---|
| `audit_logs` | `SELECT, INSERT` only | append-only, explicit `REVOKE UPDATE, DELETE, TRUNCATE` (0007) |
| `organizations` | `SELECT, INSERT, UPDATE` (no `DELETE`) | no-hard-delete from day one (0013) |
| `users`, `workspaces`, `channels`, `messages` | `SELECT, INSERT, UPDATE` (no `DELETE`) | `DELETE` explicitly revoked after the fact (0013) — these four had it under 0007's original broad grant, defense-in-depth revoke since no route ever used it |
| everything else (`workspace_members`, `channel_members`, `refresh_tokens`, `app_settings`, `organization_members`, `invitations`, `mention_notifications`, `entities`, `message_entities`, `message_embeddings`, `embedding_jobs`, `user_notifications`, `membership_invitations`, `message_side_effect_jobs`) | `SELECT, INSERT, UPDATE, DELETE` | full CRUD, no restriction |

Fixed acceptance query for the installer/Section 5 checklist:

```bash
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
  WHERE grantee = '${APP_DB_USER}'
  GROUP BY table_name ORDER BY table_name;
"
# Expect audit_logs: INSERT,SELECT
# Expect organizations, users, workspaces, channels, messages: INSERT,SELECT,UPDATE
# Expect every other table: DELETE,INSERT,SELECT,UPDATE
```

---

## 3. Acceptable risk for v1.0 (unchanged from original punchlist, reviewer did not dispute)

- **Certbot/TLS**: moot in a true air gap (no path to a public CA); resolved by the enclave's own decision in Section 1.4 of this document, not a code fix.
- **Three 07-20 performance findings not re-verified this pass** (unbounded list endpoint spot-check, `fetchAllPages()`, notification summary cost, presence/composer re-render cost): UI/DB-load optimization, not correctness/authorization defects, already exercised by a 100-concurrent-user load test. 30-minute spot-check recommended, not a gate.
- **Design token contrast gaps** (`docs/reviews/ui-ux-review.md`): real, tracked as a fast-follow, not a v1.0 blocker for a known/enrolled internal user population.
- **Structured/JSON backend logging**: `console.log`/`console.error` only today; fine at single-instance scale where `docker compose logs` is the actual operational interface. Fast-follow if the enclave ever needs SIEM ingestion.
- **Frontend runtime-config for the URL-baking problem** (Section 1.2): the "rebuild per enclave" path ships v1.0; the nginx/`config.js` runtime-injection alternative is a real simplification but not required to ship once.

---

## 4. Revised installer shape (final, merges both documents' structures)

Replaces the original punchlist's Section 2.2 phase list with the corrected version:

1. Load and validate a single enclave `.env` (sourced, not just referenced).
2. Preflight: `docker`, Compose v2, `curl`, `timeout`, `xargs`, disk space, required ports free.
3. Verify `images/CHECKSUMS.sha256` against the staged tars.
4. `docker load` all three images (no `--build` anywhere in this script, ever).
5. Verify loaded image tags + digests match what `docker-compose.enclave.yml` references.
6. Start Postgres (`-f docker-compose.yml -f docker-compose.enclave.yml`); wait for `service_healthy`.
7. Verify Postgres version ≥ 16, `vector.control` present, `CREATE EXTENSION vector` succeeds.
8. Run migrations from the loaded backend image, no build; confirm `knex migrate:status`.
9. Verify `app_runtime_user` grants against the corrected table in Section 2.7 above (not the oversimplified blanket rule).
10. Confirm vLLM host reachable (`/v1/models`), confirm `LLM_MODEL`/`EMBEDDING_MODEL` both present in the served list, confirm a real `/v1/completions` round-trip.
11. Start backend/frontend, no build; wait on `/health/live`, then `/health` (confirms DB + live vLLM sweep).
12. Verify frontend static files exist and the built bundle's baked `VITE_API_URL`/`VITE_WS_URL` match the enclave's actual URL (Section 1.2).
13. Verify `CORS_ORIGIN` matches the real browser-facing origin, and `ALLOWED_LLM_ORIGINS` matches `LLM_BASE_URL`'s origin exactly.
14. Run vLLM completion/embedding/streaming/app-level AI smoke tests (Section 2.4).
15. Create first admin (guided prompt, Section 1.3) or confirm one already exists.
16. Run `verify-audit-log.mjs` in-container.
17. Write `install-report-<timestamp>.txt` (git tag, image digests, migration status, redacted env, all pass/fail results).

---

## 5. Final pre-ship checklist

Everything below must be true before go-live. Items new or corrected in this integration pass are marked **[new]**/**[corrected]**; unmarked items are unchanged from the original punchlist and were not disputed by the review.

- [ ] **[new]** `docker-compose.enclave.yml` exists, removes Ollama + `wireservice_default`, uses pinned `image:` tags, and `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config` has been run and its output saved as a release artifact.
- [ ] **[new]** Versioned, checksummed image tars exist (`silentwhisper-backend:1.0.0`, `silentwhisper-frontend:1.0.0`, `postgres-pgvector-pg16`) matching exactly what the enclave Compose file references.
- [ ] **[new]** Frontend build-time URL decision made and documented (rebuild-per-enclave for v1.0, per Section 1.2); installer verifies the built bundle's baked origin.
- [x] Root `.env.example`: `v2` prompt versions, no `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN`, **[new]** reconciled with every key in `backend/.env.example`. *(Done 2026-07-22 — see Progress log. Bonus: the reconciled keys were also wired into `docker-compose.yml`/`frontend/Dockerfile` so they're actually functional, not just documented.)*
- [ ] **[new]** `.env.enclave.example` exists with `LLM_PROVIDER=vllm` and real placeholder values, no Ollama-flavored defaults.
- [ ] Backend Docker healthcheck targets `/health/live`, in both `docker-compose.yml` and `docker-compose.enclave.yml`.
- [ ] `backend/Dockerfile` stages `/scripts`; **[corrected]** `create-first-admin.mjs`/`verify-audit-log.mjs`/`upgrade-prompt-versions.mjs` have actually been run inside a built container, not just reasoned about.
- [ ] vLLM verified against real enclave GPU hardware: completions, embeddings, **[new]** streaming, **[new]** embedding-dimension match, auth header behavior, concurrency under realistic load.
- [ ] `scripts/backup-db.sh` / `scripts/restore-db.sh` exist, **[corrected]** avoid fragile `.env` sourcing and unsanitized DB-name interpolation, and a full backup→restore→boot→login→search loop has been tested once for real.
- [ ] Docker log rotation (`x-logging` anchor) applied to `docker-compose.enclave.yml`'s postgres/backend/frontend.
- [ ] **[corrected]** Grants-verification query uses the accurate per-table matrix (Section 2.7), not a blanket "all tables except audit_logs" assumption. *(Partial — the corrected query already landed in `RUNBOOK.md`; still needs to land in `scripts/airgap-install.sh` once that script exists, 1.3/4.)*
- [ ] **[new]** `scripts/airgap-install.sh` rewritten per Section 4 above (loads `.env` first, no `--build`, no `python3` dependency, validates baked frontend URLs / CORS / `ALLOWED_LLM_ORIGINS` / embedding dimension, writes an install report) and **run start-to-finish on a clean, internet-disabled staging host** — not just read for plausibility.
- [ ] **[new]** Enclave TLS/reverse-proxy decision made by whoever owns the enclave's network topology (Section 1.4).
- [ ] Backend test suite green (`cd backend && npm test`), including audit-chain concurrency and grants tests.
- [ ] `npm audit --omit=dev` clean in both trees, re-run fresh (not trusted from an old number) — in the **networked staging environment**, not inside the air-gapped enclave, since there's no advisory mirror there.

Sign-off: every box above checked → v1.0 cleared for enclave go-live.

---

## 6. Progress log

Dated, append-only — same convention as `PROJECT_PLAN.md` Section 11 (a record of what actually landed, not a restatement of the plan above). Newest entry at the bottom.

### 2026-07-22 — Section 2.1 (root `.env.example`), all three parts

- **2.1a**: `.env.example`'s `LLM_SUMMARY_PROMPT_VERSION`/`LLM_TASK_PROMPT_VERSION` changed `v1` → `v2`, matching `backend/src/config.js`/`docker-compose.yml`'s existing default. Checked the live `.env` too — it was already on `v2`, so no deployment ever actually ran the weaker template and the `upgrade-prompt-versions.mjs` backfill wasn't needed.
- **2.1b**: Removed the dead `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN` lines from `.env.example`.
- **2.1c**: Added the 10 keys present in `backend/.env.example` but missing from root `.env.example` (`LLM_DIGEST_PROMPT_VERSION`, `ALLOWED_LLM_ORIGINS`, `AI_DIGEST_MAX_WINDOW_HOURS`, `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_MAX_CONCURRENT_REQUESTS`, `EMBEDDING_WORKER_INTERVAL_MS`, `EMBEDDING_WORKER_BATCH_SIZE`, `EMBEDDING_MAX_ATTEMPTS`, `TASK_OWNER_TOKEN_ALIAS`, `TASK_DASHBOARD_WINDOW_DAYS`). Discovered while doing this that root `.env` values only reach a service if that service's `docker-compose.yml` `environment:`/`build.args` block references them — none of the 10 were wired in, so the doc fix alone would have been cosmetic. Fixed by also adding all 10 to `docker-compose.yml`'s backend `environment:` block (same `${VAR:-default}` pattern as the existing keys), and adding a `VITE_TASK_OWNER_TOKEN_ALIAS` build arg (`frontend/Dockerfile` + `docker-compose.yml`'s frontend `build.args`, reusing the single root `TASK_OWNER_TOKEN_ALIAS` value) since that one was documented as needing to match the backend's alias exactly but had no wiring on the frontend side at all. Verified with `docker compose config` — parses clean, every new key resolves to the same default `backend/src/config.js` already used, so no runtime behavior changed; the knobs are just reachable now.
- Not done in this pass: `.env.enclave.example` (2.1's fourth deliverable) still doesn't exist.
- Also fixed as a byproduct (not part of this plan, but the same investigation surfaced it): `RUNBOOK.md`'s "Check the `app_runtime_user` grants" section had the same flat "all tables except `audit_logs`" error as this plan's Section 2.7 — corrected there directly, independent of the `scripts/airgap-install.sh` fix this plan still needs (2.7/4).
