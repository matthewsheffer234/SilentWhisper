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
| 1.1 | `docker-compose.enclave.yml` override | Partial | 2026-07-22 | File created and merge behavior verified (`docker compose config`); can't be used for a real install until 1.2's image tags exist, and its healthcheck will need the same `/health/live` fix as the base file once 2.2 lands |
| 1.2 | Versioned/checksummed offline image contract | Partial | 2026-07-22 | `scripts/build-release-images.sh` written and run end-to-end for real (built, saved, checksummed, reloaded, bundle-verified) with `localhost` placeholder URLs and version `1.0.0-devproof` to prove the contract works; those proof tars were deleted afterward (not real release artifacts — no real enclave hostname exists yet). Still needs a real run against an actual enclave's `VITE_API_URL`/`VITE_WS_URL` before the checklist item can flip to Done. |
| 1.3 | Rewrite `scripts/airgap-install.sh` | Partial | 2026-07-22 | 2.3 is now Done, unblocking in-container script calls. Every phase's actual logic (Postgres/pgvector checks, migrations, the full per-table grants matrix, vLLM JSON parsing, backend health, and the full login→workspace→channel→join→message→AI-summarize smoke test) has now been exercised for real against throwaway containers on an isolated Docker network — found and fixed a real bug in the smoke test in the process (see `## 6. Progress log`). Still not run as the literal, single, unmodified script end-to-end: this host doubles as Silent Whisper's live production deployment, and `docker-compose.yml`'s hardcoded host ports (8101/3101/5433) collide with the running prod containers — that full rehearsal needs an actually separate host, as the plan already specified. |
| 1.4 | Enclave TLS/reverse-proxy decision | **Done** | 2026-07-22 | Decided via `AskUserQuestion`: reverse proxy in front (not direct container exposure), internal/private CA certs (not self-signed), and — going beyond this section's original "document, don't generate" scope at the user's explicit request — this repo now ships a template config (`nginx.enclave.conf.example`), not just documented requirements. |
| 2.1a | `.env.example` `v1`→`v2` prompt-version fix | **Done** | 2026-07-22 | |
| 2.1b | Remove dead `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN` placeholders | **Done** | 2026-07-22 | |
| 2.1c | Reconcile root `.env.example` with `backend/.env.example` | **Done** | 2026-07-22 | Went beyond the original item: also wired the 10 new keys into `docker-compose.yml`'s backend `environment:` block and added the matching `VITE_TASK_OWNER_TOKEN_ALIAS` frontend build arg — without that, setting them in root `.env` would have been silently ignored. `.env.enclave.example` itself still not created. |
| 2.2 | Backend healthcheck → `/health/live` | **Done** | 2026-07-22 | Fixed in `docker-compose.yml` only — `docker-compose.enclave.yml` doesn't override `healthcheck:` at all, so it inherits the fix via normal merge (confirmed with `docker compose config`); its stale "does not fix this yet" header comment removed. Verified live in a throwaway container: killed Postgres under a running backend and confirmed Docker's own health status stayed `healthy` throughout (old `/health` target would have flipped it). |
| 2.3 | Ship `/scripts` inside backend image + test in a built container | **Done** | 2026-07-22 | `backend/Dockerfile` now copies `scripts/*.mjs` + symlinks `node_modules`; `create-first-admin.mjs`/`verify-audit-log.mjs`/`upgrade-prompt-versions.mjs` all run for real inside a built container against a real migrated Postgres. Error-message wording fixed in all 10 scripts that had it, not just the 3 named in the original spec (all 10 get copied into the image by the same `COPY scripts/*.mjs`). |
| 2.4 | vLLM real-hardware verification | Not started | | Needs access to real enclave/GPU hardware — external dependency, not just eng time |
| 2.5 | `backup-db.sh` / `restore-db.sh` | **Done** | 2026-07-22 | Both scripts written and the full loop tested against this host's real live `silent_whisper` DB (14 users/84 messages/4 workspaces/163 audit rows/84 embeddings) — real backup, real restore into a fresh sibling DB, verified via a throwaway backend and direct SQL, live DB never touched, all test artifacts (dump file, restored DB, throwaway container) cleaned up afterward. |
| 2.6 | Docker log rotation | **Done** | 2026-07-22 | Turned out already landed as a side effect of Section 1.1's work (the `x-logging` anchor applied to postgres/migrate/backend/frontend in `docker-compose.enclave.yml` on 2026-07-22) — this row and Section 5's checklist just hadn't been flipped to reflect it. Confirmed via `docker compose config` that it merges correctly. This section only ever scoped the fix to `docker-compose.enclave.yml`, not the base `docker-compose.yml` — flagged separately to the user since this host's live containers run off the base file and have no log rotation today. |
| 2.7 | Grants-verification query fix | **Done** | 2026-07-22 | The remaining blocker noted here (`scripts/airgap-install.sh` not existing yet) was resolved by 1.3 landing — its Phase E already carries the same corrected per-table matrix, and Section 1.3's work independently re-verified that exact query/logic against a real migrated schema (all 20 tables matched, no false positives/negatives). `RUNBOOK.md`'s copy re-confirmed unchanged and correct. Just needed this row and Section 5's checklist flipped to match reality. |
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

**Status: Partial (2026-07-22)** — file created at repo root, merge behavior verified against Compose 2.40.3; see `## 6. Progress log` for how. Blocked from real use until 1.2 (image tags) exists; still needs the `/health/live` healthcheck fix once 2.2 lands, and doesn't resolve 1.4 (proxy/TLS).

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

**Status: Partial (2026-07-22)** — `scripts/build-release-images.sh` implements the contract below and has been run end-to-end for real against `localhost` placeholder build args to prove it (built, saved, checksummed, `docker load`-verified, frontend-bundle-verified); see `## 6. Progress log`. Not yet run against a real enclave's actual `VITE_API_URL`/`VITE_WS_URL`, since no real enclave hostname exists yet to build against — that run, whenever it happens, is what actually produces a shippable release artifact.

Not "three tar files," a defined contract the installer can verify against:

```bash
# In the networked staging/build host, from a clean checkout at the release tag:
VITE_API_URL=https://<enclave-hostname>/api \
VITE_WS_URL=wss://<enclave-hostname>/ws \
SILENTWHISPER_VERSION=1.0.0 \
  ./scripts/build-release-images.sh
```

**Correction (found while implementing this, 2026-07-22): the command this section originally specified here — `docker compose -f docker-compose.yml -f docker-compose.enclave.yml build backend frontend` — silently no-ops.** `docker-compose.enclave.yml` (Section 1.1) sets `build: !reset null` on `backend`/`frontend`/`migrate` specifically so the enclave file can never trigger an accidental source build; the side effect is that the *merged* config has no `build:` section left at all, and `docker compose build` treats "no build config for this service" as nothing-to-do rather than an error — exit 0, zero images produced, no warning surfaced by default. Verified empirically before writing the fix rather than assuming the original snippet was correct. `scripts/build-release-images.sh` instead runs `docker build` directly against the **base** `docker-compose.yml`'s Dockerfiles/contexts (`backend/Dockerfile` from repo root, `frontend/Dockerfile` from `./frontend`) and tags the result with the exact tags `docker-compose.enclave.yml` references — the base file's job is building, the enclave file's job is only ever referencing already-built, already-tagged images, and the two never overlap.

The script also folds in the frontend build-time URL requirement directly (`VITE_API_URL`/`VITE_WS_URL` are required env vars, not optional) rather than leaving that as a separate manual step to forget, and self-verifies the checksum file immediately after writing it (`sha256sum -c`) so a corrupt write is caught at staging time, not at install time on the enclave host.

`docker-compose.enclave.yml` references the exact tags above (`silentwhisper-backend:1.0.0`, not `:latest`) — never rely on Compose's implicit project-derived image naming, which is what would let a stale locally-built image silently satisfy `image:` without ever being loaded from a tar. The installer (Section 1.3, Phase B) verifies the checksum file before `docker load`, and `docker image inspect` on the expected tag after — both already implemented in `scripts/airgap-install.sh`.

**Frontend build-time URL decision** — pick one, don't leave it implicit:
- **v1.0 (recommended, ships now)**: accept that the frontend image must be built once per enclave, with that enclave's final browser-facing URL baked in at staging-build time (`VITE_API_URL=https://<enclave-hostname>/api`). Document this explicitly in the runbook as a staging-time input, and have the installer verify the *built bundle actually contains* the expected origin (Section 1.3, uses the punchlist's own `grep dist/assets/*.js` idea, just pointed at the real enclave URL instead of `localhost`) rather than silently trusting that the right build args were used weeks earlier.
- **Fast-follow (not a v1.0 blocker)**: change `frontend/Dockerfile`/nginx to emit a small `/config.js` (or similar) generated from a runtime environment variable at container start, so one frontend image works across enclaves. Real, valuable simplification — don't let it block the current ship.

### 1.3 Action: rewrite `scripts/airgap-install.sh` against the corrected Compose file

**Status: Partial (2026-07-22)** — `scripts/airgap-install.sh` written, implementing every correction below plus the 17-phase shape from Section 4 (added an 18th: an end-to-end login→workspace→channel→message→AI-summarize smoke test, since Section 4 step 14 called for an "app-level AI smoke test" the original draft didn't actually have). `bash -n` and `shellcheck` both clean. 2.3 landing unblocked in-container testing; every phase's actual logic has since been verified for real against isolated throwaway containers (Postgres/pgvector checks, migrations, the full grants matrix, vLLM JSON parsing, backend health, and the smoke test) — this surfaced and fixed a real bug (the smoke test 404'd on message-send because the first admin, always a system admin, is deliberately not auto-joined to a channel it creates; fixed by adding the explicit join call). What's still not done: running the literal, unmodified script end-to-end in one process. This host is Silent Whisper's live production deployment (`silentwhisper-{backend,frontend,postgres}-1` are up serving real traffic), and `docker-compose.yml`'s hardcoded host ports collide with those running containers — a true single-process rehearsal needs a separate host, not a workaround on this one. See `## 6. Progress log`.

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

**Status: Done (2026-07-22)** — decided directly with the user rather than left for an unnamed "enclave operator": reverse proxy in front of `frontend`/`backend` (not direct container exposure), TLS certificates from the enclave's internal/private CA (not a self-signed cert needing manual rotation tracking). The user also chose to go beyond this section's original scope — which called for documenting requirements only, explicitly *not* generating a config — and have this repo ship a starting template (`nginx.enclave.conf.example`) in addition to the documented requirements. See `## 6. Progress log`.

Not a code fix — flagging because both documents' framing assumed the *existing* `wireservice-nginx-1` setup, which by definition doesn't exist in a customer's air-gapped enclave. Someone (enclave operator, most likely) needs to decide, before Phase H of the installer means anything:

- Does the enclave terminate TLS with its own reverse proxy in front of `frontend`/`backend` (most likely, matches how this app already expects to sit behind a proxy), or expose the containers' ports directly?
- Certificate source: an internal/private CA (recommended, matches the original punchlist's 3.4) or a long-lived self-signed cert with a tracked manual rotation date.
- If a proxy is used, its config (upgrade headers on `/ws`, `X-Forwarded-Proto`/`X-Forwarded-For` passthrough for `trust proxy: 1` and audit `actor_ip`) is the enclave's own artifact to write and own — this repo's installer should not attempt to generate it, only document the requirements (same "reload is scripted, edit is manual and confirmed" split `RUNBOOK.md` already uses for `wireservice-nginx-1`). **Resolved 2026-07-22, amended**: the user chose to have this repo also ship `nginx.enclave.conf.example` as a starting template, on top of (not instead of) documenting the requirements — `scripts/airgap-install.sh` still never reads or applies it; adapting and running it stays the enclave operator's own manual step.

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

**Status: Done (2026-07-22)** — fixed in `docker-compose.yml`; `docker-compose.enclave.yml` needed no change of its own since it inherits the fix through normal Compose merge (verified). See `## 6. Progress log`.

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

**Status: Done (2026-07-22)** — `backend/Dockerfile` now has the `COPY scripts/*.mjs` + `node_modules` symlink below; verified in a real built image against a real migrated throwaway Postgres, not just read for plausibility. See `## 6. Progress log`.

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

**Status: Done (2026-07-22)** — `scripts/backup-db.sh`/`scripts/restore-db.sh` written with both hardening corrections below, and the full loop tested for real against this host's live production data, not just read for plausibility. See `## 6. Progress log`.

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

**Status: Done (2026-07-22)** — already landed as a side effect of Section 1.1's `docker-compose.enclave.yml` work; confirmed correct and updated the tracker/checklist to reflect it. See `## 6. Progress log`.

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

**Status: Done (2026-07-22)** — the corrected matrix is live in both `RUNBOOK.md` and `scripts/airgap-install.sh`'s Phase E, and Section 1.3's isolated testing already exercised Phase E's exact query and `case` logic against a real migrated schema (22 migrations, all 20 tables matched). See `## 6. Progress log`.

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

- [ ] **[new]** `docker-compose.enclave.yml` exists, removes Ollama + `wireservice_default`, uses pinned `image:` tags, and `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config` has been run and its output saved as a release artifact. *(Partial 2026-07-22 — file exists, merge verified interactively; still needs a real release's image tags (1.2) before the rendered `config` output can be committed as an actual release artifact, not just a dev-time sanity check.)*
- [ ] **[new]** Versioned, checksummed image tars exist (`silentwhisper-backend:1.0.0`, `silentwhisper-frontend:1.0.0`, `postgres-pgvector-pg16`) matching exactly what the enclave Compose file references. *(Partial 2026-07-22 — `scripts/build-release-images.sh` written and proven end-to-end against `localhost` placeholder args; the real tars for an actual enclave hostname don't exist yet and are re-generated per release, not committed — see `## 6. Progress log`.)*
- [x] **[new]** Frontend build-time URL decision made and documented (rebuild-per-enclave for v1.0, per Section 1.2); installer verifies the built bundle's baked origin. *(Done 2026-07-22 — documented in `RUNBOOK.md`'s new "Enclave Image Build" section; `scripts/airgap-install.sh`'s `phase_frontend_bundle_check` already did the verification, per Section 1.3's earlier pass.)*
- [x] Root `.env.example`: `v2` prompt versions, no `GITHUB_PERSONAL_ACCESS_TOKEN`/`HF_TOKEN`, **[new]** reconciled with every key in `backend/.env.example`. *(Done 2026-07-22 — see Progress log. Bonus: the reconciled keys were also wired into `docker-compose.yml`/`frontend/Dockerfile` so they're actually functional, not just documented.)*
- [ ] **[new]** `.env.enclave.example` exists with `LLM_PROVIDER=vllm` and real placeholder values, no Ollama-flavored defaults.
- [x] Backend Docker healthcheck targets `/health/live`, in both `docker-compose.yml` and `docker-compose.enclave.yml`. *(Done 2026-07-22 — fixed in the base file, inherited by the enclave override via merge, verified with `docker compose config` and a live container test. See `## 6. Progress log`.)*
- [x] `backend/Dockerfile` stages `/scripts`; **[corrected]** `create-first-admin.mjs`/`verify-audit-log.mjs`/`upgrade-prompt-versions.mjs` have actually been run inside a built container, not just reasoned about. *(Done 2026-07-22 — see `## 6. Progress log`.)*
- [ ] vLLM verified against real enclave GPU hardware: completions, embeddings, **[new]** streaming, **[new]** embedding-dimension match, auth header behavior, concurrency under realistic load.
- [x] `scripts/backup-db.sh` / `scripts/restore-db.sh` exist, **[corrected]** avoid fragile `.env` sourcing and unsanitized DB-name interpolation, and a full backup→restore→boot→login→search loop has been tested once for real. *(Done 2026-07-22 — tested against real live production data on this host. See `## 6. Progress log`.)*
- [x] Docker log rotation (`x-logging` anchor) applied to `docker-compose.enclave.yml`'s postgres/backend/frontend. *(Done 2026-07-22 — landed as a side effect of Section 1.1, confirmed correct here. See `## 6. Progress log`.)*
- [x] **[corrected]** Grants-verification query uses the accurate per-table matrix (Section 2.7), not a blanket "all tables except audit_logs" assumption. *(Done 2026-07-22 — landed in both `RUNBOOK.md` and `scripts/airgap-install.sh`'s Phase E, and Phase E's exact query/logic was independently re-verified against a real migrated schema during Section 1.3's testing — all 20 tables matched. See `## 6. Progress log`.)*
- [ ] **[new]** `scripts/airgap-install.sh` rewritten per Section 4 above (loads `.env` first, no `--build`, no `python3` dependency, validates baked frontend URLs / CORS / `ALLOWED_LLM_ORIGINS` / embedding dimension, writes an install report) and **run start-to-finish on a clean, internet-disabled staging host** — not just read for plausibility. *(Partial 2026-07-22 — written, `bash -n`/`shellcheck` clean, and every phase's actual logic now proven against real isolated containers (not just reasoned about) — see `## 6. Progress log` for the bug this found and fixed. Running the literal script end-to-end in one process still needs an actual separate host: this one is Silent Whisper's live production deployment and its hardcoded ports collide with the running prod containers.)*
- [x] **[new]** Enclave TLS/reverse-proxy decision made by whoever owns the enclave's network topology (Section 1.4). *(Done 2026-07-22 — reverse proxy + internal CA, template shipped at `nginx.enclave.conf.example`. See `## 6. Progress log`.)*
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

### 2026-07-22 — Section 1.1 (`docker-compose.enclave.yml` override)

Added `docker-compose.enclave.yml` at repo root, meant to be layered with `-f docker-compose.yml -f docker-compose.enclave.yml`. Implements all five bullets from 1.1's spec: drops `silent-whisper-ollama`/`ollama-pull-model` entirely, drops the `wireservice_default` attachment on backend/frontend, swaps `build:` for pinned `image:` tags on migrate/backend/frontend (`silentwhisper-backend:${SILENTWHISPER_VERSION:-1.0.0}` / `silentwhisper-frontend:${SILENTWHISPER_VERSION:-1.0.0}`), leaves `postgres`'s image untouched, and adds the Section 2.6 `x-logging` block to all three.

Mechanically, this needed Compose's `!reset`/`!override` YAML merge tags (Compose spec, supported since Compose CLI 2.24; this repo's Docker Compose is 2.40.3) — plain key omission in an override file does **not** remove anything, since Compose merges mapping fields (`environment`, `depends_on`) per-key and concatenates list fields (`networks`, `ports`) rather than replacing them:
- `silent-whisper-ollama: !reset null` / `ollama-pull-model: !reset null` — drops each service from the merged result entirely.
- `depends_on: !override { postgres: {...} }` on `backend` — without `!override` here, the base file's `silent-whisper-ollama` dependency would have survived the merge even after the service itself was reset, since map merge retains keys the override doesn't touch.
- `networks: !override [default]` on `backend`/`frontend` — same reasoning; list fields concatenate by default, so this is what actually drops `wireservice_default` rather than adding to it.
- `wireservice_default: !reset null` under the top-level `networks:` key — drops the `external: true` declaration itself, so nothing checks for that network's existence on an enclave host.
- `build: !reset null` alongside the new `image:` on migrate/backend/frontend — without this, both `build:` and `image:` would coexist post-merge, leaving a latent (if unlikely) path to an accidental network build attempt.

Also added `LLM_PROVIDER: ${LLM_PROVIDER:-vllm}` to backend's environment in this file — the base file's own default (`ollama`) is meaningless once the Ollama service is gone. **Caveat found during verification**: `${VAR:-default}` only applies when `VAR` is completely unset in whatever `.env` Compose loads; this repo's actual `.env` already sets `LLM_PROVIDER=ollama` explicitly (correct for local/Silent-Lattice dev), so testing this override against that same `.env` still resolves to `ollama` — expected, not a bug. This default only does real work once an enclave operator's own `.env` (2.1c's still-uncreated `.env.enclave.example`) is what's loaded instead.

Verified with `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config` (and `--profile tools` to also render `migrate`, which `config` hides by default): confirmed no `silent-whisper-ollama`/`ollama-pull-model` in the merged services, no `build:` key anywhere, `image:` resolves to the expected tags, `wireservice_default` absent from the merged `networks:` section, and logging present on postgres/backend/frontend/migrate. Not yet done: the image tags this file references don't exist yet (1.2), so the file can't actually be used for a real `docker compose up` until then; the base file's `/health` vs `/health/live` healthcheck mismatch (2.2) will need the identical fix applied here too once that lands, since this file doesn't currently override `healthcheck:` at all (it just inherits the base file's, unfixed).

### 2026-07-22 — Section 1.3 (`scripts/airgap-install.sh`)

Wrote `scripts/airgap-install.sh` (new file, ~460 lines), implementing the corrected 17-step shape from Section 4 plus an 18th phase (an end-to-end login → workspace → channel → message → AI-summarize smoke test) — Section 4's step 14 called for an "app-level AI smoke test" through the real app, not just the direct-provider round-trip, and the original punchlist draft never actually had one.

Every specific correction from this section's spec is in the script:
- `set -a; source .env; set +a` runs before any `.env`-sourced variable is referenced (Phase A) — the original draft checked `${LLM_PROVIDER:-}` etc. directly, which only worked if the operator had separately exported them.
- No `python3` anywhere. Every bit of JSON parsing (health check, `/v1/models` model-list lookup, embedding-length check, and the smoke test's `accessToken`/`id` field extraction) runs inside a throwaway container of the already-loaded backend image (`docker run --rm -i <backend image> node -e "..."`), via a small `json_field()` helper for the simple cases. This needs nothing new on the host beyond docker/curl/coreutils, resolving the original draft's direct contradiction (recommended Bash specifically to avoid Python, then used `python3 -c` anyway).
- No `--build` anywhere; every `docker compose` call goes through a `$COMPOSE` array pinned to `-f docker-compose.yml -f docker-compose.enclave.yml`.
- Fixed the invalid timeout arithmetic (`${LLM_TIMEOUT_MS:-30000}e-3` isn't valid `curl` syntax) with real integer-seconds rounding: `$(( (${LLM_TIMEOUT_MS:-30000} + 999) / 1000 ))`.
- Added the four validations the review flagged as missing: built frontend bundle contains the expected `VITE_API_URL` (checked right after image load, via `docker run --entrypoint sh` against the loaded frontend image — before anything is even brought up, so a URL mismatch is caught early); `CORS_ORIGIN` includes the origin derived from `VITE_API_URL`; `ALLOWED_LLM_ORIGINS` includes (or is unset, which is also safe) `LLM_BASE_URL`'s own origin; the live `/v1/embeddings` response length matches `EMBEDDING_DIMENSION`.
- Uses Section 2.7's corrected per-table grants matrix (Phase E) — a `case` over every returned table, not a flat "all except `audit_logs`" rule; explicitly designed to fail loudly (not silently pass) if a future migration adds a table this script doesn't yet know about.
- Writes `install-report-<timestamp>.txt`: git commit/describe, loaded image IDs, resolved non-secret environment (`*_PASSWORD`/`*_SECRET`/`*_API_KEY` redacted via `sed`), and every phase's pass/fail line.
- Guided first-admin creation (interactive `read`/`read -s` prompts) rather than only printing the raw command.
- Never destructive: no `docker compose down`/`-v`, no `migrate:rollback`, no secret generation — matches the original "what this script deliberately does not do" list.
- Drops the original draft's wireservice-specific nginx-reload phase entirely (that was this *host's* Silent Lattice integration, not something an enclave installer should do) — replaced with a closing note pointing at Section 1.4, since that decision and its artifact belong to the enclave operator, not this script.

Checked with `bash -n` (syntax) and `shellcheck` (installed for this pass) — clean except two intentional single-quote infos (SC2016) where the quoting is deliberately protecting an inner `$(...)`/`{{...}}` from expanding in the outer shell (the Postgres-healthy wait loop and the `vector.control` check, both of which need to evaluate inside a different shell context — the polling subshell and the postgres container, respectively).

**Not done in this pass**: the script cannot actually be run start-to-finish yet. Two hard blockers, both already tracked: 1.2 (no real `images/*.tar`/`CHECKSUMS.sha256` to load) and 2.3 (the backend image doesn't have `/app/scripts` copied in yet, so the `create-first-admin.mjs`/`verify-audit-log.mjs` calls in Phases G/12 would fail against a real container today, even though they're correctly written against the path 2.3 will produce).

### 2026-07-22 — Section 1.2 (versioned/checksummed offline image contract)

Wrote `scripts/build-release-images.sh` (new file). Before writing it, verified empirically that this section's own original example command doesn't work: `docker compose -f docker-compose.yml -f docker-compose.enclave.yml build backend frontend` exits `0` and builds nothing, because `docker-compose.enclave.yml`'s `build: !reset null` on `backend`/`frontend` (added in Section 1.1, deliberately, so the enclave file can never trigger a source build) leaves the merged config with no `build:` section at all — `compose build` silently treats that as nothing-to-do. Corrected the approach and this section's own text to match: the script runs `docker build` directly against the base `docker-compose.yml`'s Dockerfiles (backend from repo root, frontend from `./frontend`, matching each service's documented build context) and tags the result with the exact `silentwhisper-backend:<version>`/`silentwhisper-frontend:<version>` tags `docker-compose.enclave.yml` references — base file builds, enclave file only ever references what's already built and tagged.

The script: requires `VITE_API_URL`/`VITE_WS_URL` as env vars (fails fast if unset, rather than silently baking in whatever `frontend/Dockerfile`'s own `ARG` defaults would resolve to), builds backend and frontend, pulls `pgvector/pgvector:pg16`, saves all three to `images/*.tar`, writes `images/CHECKSUMS.sha256`, and immediately self-verifies that checksum file with `sha256sum -c` before declaring success — catching a corrupt write at staging time instead of at install time on the enclave host.

**Ran it for real** (network is available in this session, unlike a true enclave — this stood in for the "networked staging/build host" the plan calls for): `VITE_API_URL=http://localhost:8101/api VITE_WS_URL=ws://localhost:8101/ws SILENTWHISPER_VERSION=1.0.0-devproof ./scripts/build-release-images.sh`. Both images built successfully, all three tars saved, checksums written and self-verified. Then went further than the script itself does, to prove the *installer's* consumption side too: deleted the freshly-built local images, `docker load`-ed all three tars back in from the saved tar files, confirmed `docker image inspect` found both expected tags, confirmed the frontend bundle's built JS actually contains the baked `http://localhost:8101/api` string (same check `scripts/airgap-install.sh`'s `phase_frontend_bundle_check` does), and confirmed `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config --services` resolves cleanly once `SILENTWHISPER_VERSION` matches the loaded tags.

**Cleaned up afterward**: deleted the `1.0.0-devproof`-tagged local images and the `images/` directory — these were a proof run against `localhost`, not a real release artifact for an actual enclave, and 225MB of tars with a dev-only version tag isn't something to leave sitting around or commit. Added `images/` to `.gitignore` (release tars are regenerated build output, not source).

Documented the frontend build-time URL decision explicitly in `RUNBOOK.md`'s new "Enclave Image Build" section (this section's own spec called for this, separately from the script) — rebuild-per-enclave is v1.0's answer, backend/postgres images are enclave-agnostic and build once per release, and `scripts/airgap-install.sh` already enforces the bundle-content check rather than trusting the right build args were used weeks earlier.

**Not done in this pass**: no real enclave hostname exists yet, so no real, shippable `silentwhisper-frontend:1.0.0` tar exists — only the proof run (since deleted) that the contract itself works. The tracker/checklist above are marked Partial, not Done, for that reason. `docker-compose.enclave.yml`'s header comment (Section 1.1's file) still correctly states the tags it references don't exist yet — that comment wasn't changed, since it's still true; a pointer to `scripts/build-release-images.sh` was added to it so a future reader lands on the actual mechanism.

### 2026-07-22 — Section 2.3 (ship `/scripts` inside the backend image)

Added to `backend/Dockerfile`, right after the existing `COPY database/` line, exactly as this section specified: `COPY scripts/*.mjs /app/scripts/` then `RUN ln -s /app/backend/node_modules /app/node_modules`. Confirmed `scripts/package.json`'s six dependencies (`bcryptjs`, `dotenv`, `jsonwebtoken`, `knex`, `pg`, `ws`) are an exact version-range match to `backend/package.json`'s own before relying on the symlink working (`^2.4.3`/`^16.4.5`/`^9.0.2`/`^3.1.0`/`^8.13.1`/`^8.18.0` on both sides).

Also fixed the stale "expected in backend/.env" error-message wording — but in **all 10** scripts that had it (`clear-test-artifacts.mjs`, `create-first-admin.mjs`, `grant-system-admin.mjs`, `link-springfield-entities.mjs`, `load-test.mjs`, `seed-demo-simpsons-workspace.mjs`, `seed-demo-tv-workspace.mjs`, `seed-springfield-investigation.mjs`, `upgrade-prompt-versions.mjs`, `verify-audit-log.mjs`), not just the 3 this section named for in-container testing — the `COPY scripts/*.mjs` line copies every one of them into the image, so all 10 needed the same fix, not only the ones the installer happens to call.

**Verified in a real built container, not just read for plausibility**, matching this section's own instruction: built the backend image, stood up a throwaway `pgvector/pgvector:pg16` container on its own Docker network (never touching this host's actual `docker-compose.yml` project, which — discovered while planning this — is also Silent Whisper's live production deployment on this host; see the 1.3 entry below), ran `npm run migrate` against it (22 migrations applied cleanly), then ran all three named scripts for real inside the built image:
- `node /app/scripts/verify-audit-log.mjs` — `0 row(s) checked, chain intact`.
- `node /app/scripts/create-first-admin.mjs test-admin test-admin@example.com "TestPassw0rd!23"` — created the admin, printed its id.
- `node /app/scripts/upgrade-prompt-versions.mjs` — correctly reported nothing to do.

Also confirmed the message-wording fix is actually live: running `verify-audit-log.mjs` with `PGHOST` unset printed the new "...on the host, or already injected via Docker Compose/the container environment when run inside a container" wording, not the old host-only phrasing. Cleaned up the throwaway Postgres container/network/image afterward.

### 2026-07-22 — Section 1.3 continued (piecemeal verification of `scripts/airgap-install.sh`'s actual phase logic)

**Important discovery before any of this started**: this host is not a disposable dev sandbox — `docker ps` showed `silentwhisper-{backend,frontend,postgres,silent-whisper-ollama}-1` all up and healthy, the actual live deployment behind `https://whisper.silentlattice.dev` (`RUNBOOK.md`'s Production Deployment section), and `docker-compose.yml` hardcodes the same host ports (127.0.0.1:8101/3101/5433) those containers already hold. Running `scripts/airgap-install.sh` as literally written — which drives `docker compose -f docker-compose.yml -f docker-compose.enclave.yml` against *this* directory — would either collide with the live project or, if deliberately isolated (distinct `COMPOSE_PROJECT_NAME`), still fail to bind those same hardcoded ports. Asked the user how to proceed rather than attempting a workaround against a host serving real traffic; chose to validate the installer's actual logic piecemeal against fully isolated throwaway containers/networks (never using the `docker-compose.yml`/`docker-compose.enclave.yml` files or this project's compose name at all) instead of a literal single-process run. `.env` was read and backed up to a scratchpad copy for reference but never modified; confirmed via checksum before and after that it was untouched.

Built `silentwhisper-backend:1.0.0-proof13` / `silentwhisper-frontend:1.0.0-proof13` via `scripts/build-release-images.sh` (also re-confirming 1.2's script still works cleanly with 2.3's Dockerfile change). On an isolated `sw13-net` Docker network:

- **Phase C (Postgres/pgvector) logic**: stood up pgvector/pgvector:pg16, ran the exact `pg_isready`, `vector.control` existence, and `CREATE EXTENSION vector` checks the script runs — all passed for real.
- **Phase D (migrate)**: ran migrations via the built backend image — 22 migrations applied.
- **Phase E (grants matrix)**: ran the exact query and the exact bash `case` logic from `phase_grants` against the real post-migration schema. Every table matched Section 2.7's matrix precisely — no false positives or negatives across all 20 tables.
- **Phase F (vLLM JSON parsing)**: since no real vLLM hardware exists here (Section 2.4 is a separate, still-blocked, hardware-gated item — this does **not** substitute for it), stood up a small OpenAI-compatible mock server (`/v1/models`, `/v1/completions`, `/v1/embeddings`) as a throwaway container on the same network, and ran the script's exact `docker run --rm -i <backend image> node -e "..."` JSON-parsing snippets against it: model-list check, completion round-trip, and embedding-dimension check all passed with the real backend image's Node runtime.
- **Phase G (bring-up) + validate_config**: ran the backend image standalone (`docker run`, not compose) wired to the throwaway Postgres and mock vLLM, published on a non-conflicting host port (18101). `/health/live` and `/health` (with real `ai.healthy: true` against the mock provider) both came back correct. Unit-tested `phase_validate_config`'s `CORS_ORIGIN`/`ALLOWED_LLM_ORIGINS` comma-delimited exact-match logic directly with 4 cases including a substring-collision trap (`enclave.internal` vs `enclave.internal.evil.com`) — all correct, no false-positive substring matches.
- **Phase first_admin + smoke_test — found and fixed a real bug**: running the exact smoke-test sequence (login → create workspace → create channel → send message → AI summarize) against the standalone stack, the message-send step 404'd with "Channel not found." Root cause: `create-first-admin.mjs` hardcodes `is_system_admin = true`, and `backend/src/routes/workspaces.js`'s channel-creation route deliberately does **not** auto-join a system admin to a channel created via the `requireWorkspaceMemberOrSystemAdmin` structural-override path (a real, intentional security boundary — Finding 1, `docs/reviews/security-performance-review-2026-07-20.md` — creating a channel is structural management, not a standing grant of message-content read access; `requireWorkspaceMemberOrSystemAdmin` returns `viaSystemAdminOverride: true` for *any* system admin regardless of actual workspace membership, per `backend/src/authz/membershipService.js:97-108`). This means `phase_smoke_test` would 404 on **every real enclave install**, not just in this test — it always runs as the freshly-created first admin, which is always a system admin. Fixed `scripts/airgap-install.sh` by adding an explicit `POST .../channels/:channelId/join` call (the same self-join endpoint a genuine member would use for a PUBLIC channel) between channel creation and message send, with a comment explaining why. Re-ran the corrected sequence against the same throwaway stack end to end — join (204), message (201), AI summarize (200) — all real HTTP responses, not mocked.
- **Audit chain**: `verify-audit-log.mjs` re-run after all of the above (admin creation, login, workspace/channel/join/message/summarize) reported `8 row(s) checked, chain intact` — a real, non-empty, real-activity chain check, stronger signal than 2.3's earlier empty-table pass.

`bash -n` and `shellcheck` re-run clean on the updated script (same two pre-existing intentional `SC2016` infos as before, no new issues).

Cleaned up every throwaway resource afterward: all `sw13-*` containers, the `sw13-net` network, both proof-tagged images, `images/*.tar`, and scratchpad temp files. Confirmed via `docker ps` that the four live `silentwhisper-*`/`wireservice-*` production containers were untouched throughout, and `.env`'s checksum still matches its pre-session value.

**Still not done**: the literal, single-process `scripts/airgap-install.sh` has never been run start-to-finish — that genuinely requires a separate host, not a workaround on this one (this host being production infrastructure, discovered mid-session, is now itself a fact worth keeping in mind for any future work here that reaches for `docker compose` against this directory's project name).

### 2026-07-22 — Section 1.4 (enclave reverse-proxy / TLS decision)

This section was explicitly framed as "not a code fix... someone needs to decide" — asked the user directly via three questions rather than guessing or picking the "most likely" option unilaterally, since it's a real deployment/topology decision, not an engineering judgment call:

1. **TLS termination**: reverse proxy in front of `frontend`/`backend`, or expose container ports directly? → **Reverse proxy in front** (the recommended option — matches how this app already expects to sit behind one).
2. **Certificate source**: internal/private CA, or long-lived self-signed with tracked rotation? → **Internal/private CA** (the recommended option — no manual rotation-date tracking to forget).
3. **Config ownership**: enclave operator writes it from documented requirements only (this section's original scope), or this repo ships a starting template? → **User chose to have this repo ship a template**, going beyond the section's original "document, don't generate" framing.

Implemented the third answer: added `nginx.enclave.conf.example` at the repo root. Path-based routing (`/ws` and `/api/*` to `backend:8000`, everything else to `frontend:3000`, matching how `backend/src/index.js` mounts its own `/api/...` routers and how the shared `wireservice-nginx-1` already routes `whisper.silentlattice.dev` today), TLS termination with placeholder internal-CA cert/key paths, HTTP→HTTPS redirect, and the three requirements the file's own header comment calls out explicitly so a future editor doesn't drop them while adapting it: WebSocket `Upgrade`/`Connection` headers on `/ws` (`backend/src/ws/server.js` needs these or real-time features break silently), `X-Forwarded-Proto`/`X-Forwarded-For` passthrough matching `backend/src/index.js`'s `trust proxy: 1` (exactly one hop — chaining a second proxy in front without raising this makes `req.ip`/audit `actor_ip` spoofable), and passing `/api` through unstripped (backend's routers are mounted with the prefix already on them).

Validated with `nginx -t` inside a throwaway `nginx:alpine` container (`--add-host backend:127.0.0.1 --add-host frontend:127.0.0.1` to satisfy the upstream resolution the template's directives require, since no real compose network exists standalone) — syntax-only, not a live TLS/WebSocket handshake, which needs an actual hostname/certificate/running backend to mean anything. Documented all of this — the resolved decision, the template's existence, and the three non-negotiable requirements — in a new `RUNBOOK.md` "Enclave Reverse Proxy / TLS" section, following the same "reload is scripted, edit is manual and confirmed" split the runbook already uses for `wireservice-nginx-1`. `scripts/airgap-install.sh` remains unchanged — it still never touches proxy/TLS, exactly as this section originally specified.

### 2026-07-22 — Section 2.2 (backend healthcheck → `/health/live`)

Changed `docker-compose.yml`'s backend `healthcheck.test` from `/health` to `/health/live`, with a comment recording the reviewer's correct, narrower framing (already agreed in this section's spec): `ai.healthy` never flips `/health`'s HTTP status today, so this isn't fixing a "vLLM blip causes a restart loop" risk — that one isn't real. It's fixing the DB-coupling risk, which is: `/health` 503s on `checkDbConnection()` failure, so a routine Postgres maintenance window would trip a liveness-driven restart of an otherwise-healthy backend process.

Checked whether `docker-compose.enclave.yml` also needed the change, per this section's own original code block (labeled "docker-compose.yml AND docker-compose.enclave.yml"): it doesn't. `docker-compose.enclave.yml` doesn't override `healthcheck:` for backend at all, so it inherits the base file's (now-fixed) healthcheck through normal Compose merge — confirmed with `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config backend`, which shows the merged `test:` already targeting `/health/live`. Removed the enclave file's own header comment that had flagged this as unfixed (it was tracking a real gap that no longer exists), and separately updated its Section 1.4 bullet to reflect that decision's resolution earlier in this session — both stale-comment cleanups landed in the same pass since they're adjacent lines in the same header block.

**Verified live, not just read for plausibility**: built the backend image, ran it in a throwaway container against a throwaway Postgres with the exact `--health-cmd` from the compose fix, confirmed `healthy` status. Then stopped Postgres under the running backend and confirmed `GET /health` immediately reported `{"status":"error","db":"unreachable",...}` while Docker's own `.State.Health.Status` stayed `healthy` throughout (every probe exit code 0) — the precise behavior this fix is meant to produce, proven under a real DB outage rather than assumed from reading the diff. Cleaned up all throwaway containers/network/image afterward.

**Not done in this pass, deliberately out of scope**: did not redeploy the live `silentwhisper-backend-1` container running on this host to pick up the new healthcheck — that's a separate action (recreating a container serving real traffic) from fixing the source file, and wasn't asked for as part of this item.

### 2026-07-22 — Section 2.5 (`backup-db.sh` / `restore-db.sh`)

Wrote both scripts with the two hardening corrections this section specifies: `backup-db.sh` reads `POSTGRES_USER`/`POSTGRES_DB` via `docker compose exec postgres printenv` rather than parsing `.env` directly (avoids the punchlist draft's `source <(grep ...)` breaking on any secret with a shell-meaningful character), and `restore-db.sh` validates `TARGET_DB` against a strict `^[a-zA-Z_][a-zA-Z0-9_]*$` allowlist (plus a 63-byte length cap, Postgres's own identifier limit) before it ever reaches a `CREATE DATABASE` statement, closing the SQL-injection-via-shell-argument hole in the original draft. `restore-db.sh` also refuses to run if the target database name already exists — it only ever creates a new database, never drops or overwrites one. `backup-db.sh` refuses to overwrite an existing output file. `pg_dump -Fc`/`pg_restore` (custom format), not plain SQL — restorable into a differently-named database via `pg_restore -d`, unlike plain SQL dumps which bake in the original database name.

Asked the user how to test the full loop (this section explicitly calls for real backup→restore→boot→verify, not just confirming the scripts run) — real production data was small (14 users, 84 messages, 4 workspaces, 163 audit rows, 84 message_embeddings) and the user chose to test against it directly rather than synthetic seed data, since that's what the section actually asks for.

**Tested for real, entirely non-destructively**:
- `scripts/backup-db.sh` — dumped the live `silent_whisper` DB (248K, custom format) to `backups/` (gitignored, added in this pass — dumps contain real emails/password hashes/message content and must never be committed).
- `scripts/restore-db.sh backups/....dump silent_whisper_restore_test` — created a new sibling database on the *same running Postgres instance* (not a second Postgres, not overwriting anything) and restored into it. `pg_restore` completed with no errors.
- Confirmed the live `silent_whisper` DB's row counts were unchanged throughout (14/84/4/163), and the restored copy matched exactly, plus `message_embeddings: 84` (full coverage on this dataset).
- `app_runtime_user`'s grants on the restored DB matched Section 2.7's matrix exactly, with no re-run of the grants migration needed — `pg_dump -Fc` includes each object's ACLs by default, and this confirms that isn't just a manual assumption.
- `idx_message_embeddings_hnsw.indisvalid = 't'` on the restored copy, and a real `<=>` (cosine distance) nearest-neighbor query against `message_embeddings` returned correctly distance-ordered results (`0, 0.415, 0.464, ...`) — the planner chose a sequential scan over the HNSW index at this table's small size (84 rows), which is correct planner behavior for a table this size, not a restore defect; `indisvalid` is the actual signal for "did the index survive intact."
- `node /app/scripts/verify-audit-log.mjs` against the restored DB (via the already-built `silentwhisper-backend:latest` image, connected to the live `silentwhisper_default` network so it could reach `postgres` and `silent-whisper-ollama` by container name): `163 row(s) checked, chain intact from genesis to id=14127` — the exact same chain length as the live DB, confirming the hash-linked audit log survives dump/restore byte-for-byte.
- Booted a throwaway backend container (`sw25-backend`, its own host port, own JWT secret — never touching the live `backend`/`frontend`/`silent_whisper` containers) pointed at the restored DB with `LLM_PROVIDER=ollama`/`LLM_BASE_URL=http://silent-whisper-ollama:11434` (the real, already-running Ollama instance — read-only inference calls only): `/health` reported `db: ok` and real `ai.healthy: true`. Created a new admin via `create-first-admin.mjs`, logged in through the real `/api/auth/login` endpoint, and confirmed `GET /api/audit/logs` returned real historical audit rows from the original production data (e.g. a genuine `AUTH_TOKEN_REFRESH` entry from `2026-07-21`) — proving the restored data is queryable through the actual app layer, not just via direct SQL. (`GET /api/workspaces` correctly returned empty for this new admin — expected, not a restore bug: workspace/channel listing is membership-scoped, and system admins deliberately don't get standing visibility into workspace content they didn't create or join, same boundary documented in Section 1.3's smoke-test fix.)

Cleaned up every artifact afterward: dropped `silent_whisper_restore_test`, removed the throwaway backend container, deleted the dump file and the now-empty `backups/` directory, removed scratchpad temp files. Confirmed via `docker ps`/`psql` that only the original `silent_whisper`/`silent_whisper_test` databases and the four live production containers remained, unchanged, throughout.

**Not done in this pass**: operational cadence (schedule, retention, off-host copy) is explicitly the enclave operator's own decision per this section's own text, not something this repo's scripts prescribe.

### 2026-07-22 — Section 2.6 (Docker log rotation)

No new work needed: `docker-compose.enclave.yml`'s `x-logging` anchor (added during Section 1.1's implementation, 2026-07-22) already applies `logging: *default-logging` to `postgres`, `migrate`, `backend`, and `frontend`, matching this section's spec exactly (`json-file`, `max-size: 10m`, `max-file: "5"`) — no Ollama entry exists in the enclave file to add it to, also matching the spec. Re-confirmed with `docker compose -f docker-compose.yml -f docker-compose.enclave.yml config`: the merged output shows the logging block correctly present on all three services. This item's tracker row and Section 5 checklist box just hadn't been flipped when 1.1 landed — done now.

Flagged separately to the user (not fixed without asking, since it's outside this section's stated scope): this section only ever specifies the fix for `docker-compose.enclave.yml`, never the base `docker-compose.yml` — but this host's actual live containers (`silentwhisper-{postgres,backend,frontend,silent-whisper-ollama}-1`) run off the base file and have no log rotation configured today. Current log sizes are small (Ollama's is the largest at 7.4M), so there's no immediate urgency, but the same unbounded-`json-file`-growth risk this section describes for the enclave is equally real for this host's own long-running containers.

User chose to also fix the base file. Added the same `x-logging` anchor to `docker-compose.yml` and `logging: *default-logging` to all six services (`postgres`, `migrate`, `backend`, `silent-whisper-ollama`, `ollama-pull-model`, `frontend`) — more than this section's three-service scope, but consistent with matching the enclave file's own treatment of `migrate`, plus the two Ollama services that only exist in the base file at all. Verified with `docker compose config` (`--profile tools` to also render `migrate`/`ollama-pull-model`, hidden by default): all six services show the logging block; the enclave-merged config (`docker compose -f docker-compose.yml -f docker-compose.enclave.yml config`) still renders cleanly with `postgres`/`backend`/`frontend` present, unaffected by the base-file addition.

Note this doesn't take effect on the containers already running on this host until they're recreated — a compose file edit alone doesn't touch a running container's logging driver. Left that as a separate, explicitly-confirmed decision rather than assumed.

### 2026-07-22 — Section 2.7 (grants-verification query fix)

No new work needed: this item's only remaining piece — `scripts/airgap-install.sh` not existing yet — was closed when Section 1.3 landed, and that script's Phase E already carries the exact corrected per-table matrix this section specifies (`audit_logs`: `INSERT,SELECT` only; `organizations`/`users`/`workspaces`/`channels`/`messages`: `INSERT,SELECT,UPDATE`; everything else: full CRUD). Section 1.3's isolated piecemeal testing pass had already run Phase E's precise query and `case` logic against a real, fully-migrated throwaway schema and confirmed all 20 tables matched with no false positives or negatives — that verification already covers this item, it just hadn't been cross-referenced back to this row. Re-confirmed `RUNBOOK.md`'s independent copy of the same matrix (`### Check the app_runtime_user grants match Section 5`) is still correct and unchanged. Updated the tracker row, this section's status line, and Section 5's checklist (already `[x]`, just needed its note corrected) to reflect that both copies have been real, not just documented.
