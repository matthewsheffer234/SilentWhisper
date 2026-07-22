# Third-Party Review of `SHIPMENT_PUNCHLIST.md`

Prepared: 2026-07-21  
Scope: repository review only; no code changes made. I read the shipment punchlist and inspected the current Compose, Dockerfiles, env examples, runtime config, LLM adapter, health endpoints, migrations/grants, operational scripts, and relevant frontend API behavior.

## Executive Conclusion

The punchlist is directionally strong and identifies several real pre-ship issues, especially the stale root `.env.example` prompt defaults, missing backup/restore procedure, missing Docker log rotation, and the need to test vLLM against real enclave GPU infrastructure. It is not yet a "minimal tinkering" installation plan.

The highest-risk gap is that the current repository does not contain an enclave-ready deployment artifact. `docker-compose.yml` is still the local/Silent Lattice host topology: it depends on `silent-whisper-ollama`, attaches backend/frontend to an external `wireservice_default` network, uses `build:` directives that will rebuild from source, and bakes frontend API/WS URLs at image build time. Loading image tars alone will not make this Compose file perform an offline vLLM-only install.

My recommendation is to treat v1.0 shipment as blocked until you add and test a dedicated enclave Compose/override plus an installer that uses it end-to-end on a clean, internet-disabled host or VM. The punchlist can be the basis for that work, but several snippets in it would fail as written.

## Go/No-Go Assessment

Current readiness: **No-Go for a low-tinkering enclave install next week without packaging work.**

Codebase readiness: **Close, but not fully proven.** The app is substantially hardened and appears compatible with an intranet/offline runtime model. vLLM real-hardware testing remains a hard gate.

Packaging readiness: **Not ready.** There is no working air-gapped installer, no enclave Compose file, no stable image-tag contract for loaded tars, no backup/restore scripts, and no log rotation.

Documentation readiness: **Mixed.** The punchlist is detailed, but it overstates "verified" in places and includes operational commands that do not match the current repo or a fresh air-gapped RHEL server.

## Must Fix Before Shipment

### 1. Create an Enclave-Specific Compose Artifact

The current `docker-compose.yml` cannot be used as-is for the target topology:

- `backend.depends_on` requires `silent-whisper-ollama` even when `LLM_PROVIDER=vllm`.
- `silent-whisper-ollama` and `ollama-pull-model` are still part of the stack.
- `backend` and `frontend` attach to external network `wireservice_default`, which will not exist on a fresh enclave host unless separately created.
- `backend`, `migrate`, and `frontend` use `build:`. In an air gap, `docker compose up -d --build backend frontend` will try to build and run `npm install`/`npm ci`.
- The frontend image bakes `VITE_API_URL` and `VITE_WS_URL` at build time, so a generic prebuilt frontend image will point at whatever URL was used during staging.

Add either `docker-compose.enclave.yml` or a clearly documented override that:

- Removes `silent-whisper-ollama` and `ollama-pull-model`.
- Removes or replaces `wireservice_default`.
- Uses explicit `image:` tags for `postgres`, `backend`, `migrate`, and `frontend`.
- Runs with `--no-build` in the installer.
- Defines the intended enclave reverse-proxy exposure model.
- Documents that the frontend image must be built for the final enclave API/WS URLs, or changes the frontend container to generate runtime config at startup.

Without this, the "load offline image tars" phase is not connected to what Compose actually starts.

### 2. Fix Root `.env.example` and Provide an Enclave `.env` Template

The punchlist is correct that root `.env.example` still has:

```env
LLM_SUMMARY_PROMPT_VERSION=v1
LLM_TASK_PROMPT_VERSION=v1
```

Because Compose reads the root `.env`, this overrides the `docker-compose.yml` fallback of `v2`. Fix those to `v2`.

Also remove these unused and misleading placeholders:

```env
GITHUB_PERSONAL_ACCESS_TOKEN=your_github_pat_here
HF_TOKEN=your_huggingface_token_here
```

For the enclave, do not make operators adapt the local/Ollama example. Add a dedicated template, for example `.env.enclave.example`, with:

- `LLM_PROVIDER=vllm`
- `LLM_BASE_URL=<internal vLLM origin>`
- `ALLOWED_LLM_ORIGINS=<same exact internal vLLM origin(s)>`
- `LLM_MODEL=<served generation model>`
- `EMBEDDING_MODEL=<served embedding model>`
- `EMBEDDING_DIMENSION=<actual dimension>`
- `VITE_API_URL` and `VITE_WS_URL` matching the final built frontend
- `CORS_ORIGIN` matching the final browser origin
- no internet-token placeholders

Root `.env.example` is missing several newer backend knobs that exist in `backend/.env.example`, including `ALLOWED_LLM_ORIGINS`, `LLM_DIGEST_PROMPT_VERSION`, embedding timeout/concurrency settings, and task settings. That split is manageable for dev, but it is a problem for a one-shot install because Compose is driven by the root `.env`.

### 3. Build a Real Offline Image Contract

The punchlist says to stage:

```text
postgres-pgvector-pg16.tar
silentwhisper-backend.tar
silentwhisper-frontend.tar
```

That is incomplete unless the image tags inside the tars exactly match what the enclave Compose file references.

Define this explicitly:

- Staging build command.
- Exact image tags, preferably versioned, e.g. `silentwhisper-backend:1.0.0`.
- `docker save` commands.
- SHA256 checksums for every tar.
- Enclave-side checksum verification before `docker load`.
- Enclave-side `docker image inspect` verification after load.
- `docker compose -f docker-compose.enclave.yml up -d --no-build ...`.

Do not rely on Compose's implicit project-service image names. They are easy to mismatch.

### 4. Exercise vLLM Against Real Hardware Before Go-Live

The punchlist is right to upgrade this to a must-fix. The vLLM path is unit-tested against mocked OpenAI-compatible responses, but the target enclave uses vLLM as the only inference path.

Verify all of these against the actual enclave GPU host or a faithful staging equivalent:

- `GET /v1/models`
- `POST /v1/completions`
- `POST /v1/embeddings`
- streaming completions when `LLM_STREAMING_ENABLED=true`
- auth header behavior with `LLM_API_KEY`
- embedding dimension exactly matching `EMBEDDING_DIMENSION`
- backend `/health` reports AI provider healthy after startup sweep
- app summarize, task extraction, workspace digest, and semantic search through the real backend
- concurrency under realistic AI and embedding load

The sample punchlist command `curl --max-time "${LLM_TIMEOUT_MS:-30000}e-3"` is invalid for converting milliseconds to seconds. Replace it with explicit shell arithmetic or a fixed timeout.

### 5. Add Backup and Restore Scripts, Then Test a Restore

The punchlist is correct that no backup/restore scripts exist. This is a blocker for real data in an air-gapped enclave.

Add scripts and test the full loop:

- take `pg_dump -Fc`
- verify with `pg_restore --list`
- restore into a new database
- point the app at restored data
- confirm login, message history, audit verification, and semantic search
- confirm HNSW index validity after restore

One caution: the punchlist's sample `source <(grep ...) .env` style is fragile with special characters in secrets. Prefer Docker Compose's already-parsed environment, or load env files with a constrained parser. Passwords generated by the runbook can contain only hex today, but the scripts should not silently become unsafe if an operator uses a stronger password generator.

### 6. Add Docker Log Rotation

The punchlist is correct: `docker-compose.yml` has no `logging:` blocks, so Docker's default `json-file` logs can grow without bound.

Add a shared logging anchor to all long-running services in the enclave Compose file at minimum:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"
```

Apply it to `postgres`, `backend`, and `frontend`.

### 7. Fix the Backend Docker Healthcheck Target

The punchlist is right that Docker liveness should use `/health/live`, not `/health`.

Nuance: current `/health` only returns HTTP 503 when DB is unreachable; AI health is included in the JSON body but does not change the endpoint status. So the healthcheck is not vLLM-coupled today, but it is still DB-coupled and therefore the wrong signal for container liveness.

Use:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

Keep `/health` for installer readiness and monitoring.

## Installer Review

The proposed `scripts/airgap-install.sh` is a useful outline but not executable as written.

Major issues:

- It checks `${LLM_PROVIDER:-}` and `${LLM_BASE_URL:-}` without first loading `.env`, so it will fail unless the operator has manually exported those variables in the shell.
- It recommends Bash to avoid Python as a host dependency, then uses `python3` repeatedly for JSON parsing.
- It uses `docker compose up -d --build backend frontend`, which defeats offline image loading.
- It uses the current Compose model, which still requires Ollama and `wireservice_default`.
- It assumes `curl` is installed on the host. Likely on RHEL, but still should be a preflight requirement.
- It assumes `timeout`, `xargs`, and `docker inspect` format behavior. Fine for Linux, but document these as requirements.
- It checks `/v1/models` but the configured model checks should parse JSON robustly. Prefer running a small Node script inside a known container rather than requiring host Python.
- It prints a `create-first-admin` command but does not provide a guided prompt or idempotent first-admin path. For a Windows-95-style install feel, the installer should ask for or accept admin username/email/password and create the account.
- It does not validate frontend baked URLs. This is a major real-world failure mode: the UI can load but call the wrong API/WS origin.
- It does not validate `CORS_ORIGIN` against the browser-facing URL.
- It does not validate `ALLOWED_LLM_ORIGINS` against `LLM_BASE_URL`, even though that control is load-bearing.
- It does not produce or save an install report with versions, image digests, env redactions, and smoke-test outcomes.

Recommended installer shape:

1. Load and validate a single enclave env file.
2. Verify host prerequisites: Docker, Compose v2, curl or an equivalent test container, available disk, required ports, and required external vLLM reachability.
3. Verify tar checksums.
4. `docker load` images.
5. Verify loaded tags and digests.
6. Start Postgres with enclave Compose.
7. Run migrations from the preloaded backend/migrate image without build.
8. Verify pgvector extension and app grants.
9. Start backend/frontend without build.
10. Wait on `/health/live`, then `/health`.
11. Verify frontend static files and baked API/WS URLs.
12. Run vLLM completion, embedding, and app-level AI smoke tests.
13. Create first admin or confirm one exists.
14. Run audit verification.
15. Write `install-report-<timestamp>.txt` with secrets redacted.

## Codebase Findings Relevant to Air Gap

### Runtime Egress

The source supports the punchlist's core zero-public-egress claim:

- CSP uses self-only defaults and `connectSrc: ["'self'"]`.
- Frontend runtime source does not reference CDNs, Google Fonts, analytics, or telemetry SDKs.
- Backend dependencies are ordinary local server dependencies and do not imply telemetry.
- Lockfiles contain public registry URLs, but those are dependency provenance/build metadata, not runtime fetches.

The one intended runtime network dependency is the configured LLM provider. In the enclave, that means backend to vLLM host(s). Enforce that at two layers:

- app layer: exact `ALLOWED_LLM_ORIGINS`
- network layer: container egress allow only to Postgres and vLLM target(s)

### vLLM Adapter

The adapter uses:

- `/v1/completions` for generation
- OpenAI-style SSE parsing for streaming
- `/v1/embeddings` for embeddings
- `/v1/models` for health
- embedding dimension validation

This is a reasonable implementation, but real vLLM deployments vary in gateway behavior, auth handling, served model names, streaming details, and embedding support. The punchlist's real-hardware gate is essential.

### Database Grants

The punchlist's least-privilege theme is sound. The original grants migration covers early tables and later migrations add grants for later tables such as invitations, notifications, embeddings, entities, membership invitations, and message side-effect jobs. `audit_logs` remains restricted to SELECT/INSERT plus sequence usage.

The proposed installer query should not expect every table to have SELECT/INSERT/UPDATE/DELETE except `audit_logs`. Some tables intentionally have no DELETE on runtime user after the no-hard-delete migration, and `organizations` is granted SELECT/INSERT/UPDATE. The acceptance check should compare against the actual policy, not an oversimplified table-wide rule.

### Maintenance Scripts Inside the Backend Container

The punchlist's idea to run maintenance scripts inside the backend container is good for an air-gapped install, but it requires an image change. Current `backend/Dockerfile` does not copy `/scripts`.

If you adopt this, make it explicit:

- copy `scripts/*.mjs` into the backend image
- ensure module resolution works for both scripts' direct dependencies and imported backend modules
- test `create-first-admin.mjs`, `verify-audit-log.mjs`, and `upgrade-prompt-versions.mjs` inside the running backend container

The current script comments say they expect `backend/.env`, but they will work from injected environment variables if those are present. That should be documented, because the error messages still say "expected in backend/.env".

### Frontend Runtime Configuration

This is one of the easiest details to miss. `frontend/Dockerfile` bakes `VITE_API_URL` and `VITE_WS_URL` at build time. Therefore:

- the staging host must know the final enclave browser-facing URLs before building the frontend image, or
- the app needs a runtime config file generated by nginx/container startup, or
- you need one frontend image per enclave URL.

For minimal-tinkering installs, runtime config is usually better than rebuilding per environment. If you keep the current build-time model, make the installer verify the built bundle contains the expected API and WS origins.

## Punchlist Corrections

These are specific claims or instructions I would revise:

- "Backend healthcheck targets `/health` instead of `/health/live`" is correct, but the stated vLLM restart-loop risk is overstated because AI health does not affect `/health` HTTP status. The DB-coupled liveness risk remains real.
- "Load offline images" is incomplete because Compose does not reference the proposed loaded tags for backend/frontend.
- "No Ollama image" conflicts with current `docker-compose.yml`; an enclave Compose file must remove the service and backend dependency.
- "Run maintenance scripts inside backend" conflicts with current `backend/Dockerfile`; implement and test it before documenting it as the default.
- "Bash, not Python" conflicts with the installer snippets using `python3`.
- The model-list parsing in Phase F assumes a very specific `/v1/models` JSON shape. That is probably right for OpenAI-compatible vLLM, but still should fail with a clear message if the shape differs.
- The backup script sample uses fragile env sourcing and writes backups to `./backups` without addressing permissions, free space, retention, or storage off the Docker host.
- The restore script sample creates a database name via direct string interpolation. Keep generated names conservative and validate any user-supplied target DB name before putting it in SQL.
- The acceptance checklist's semantic search assertion permits `len(results) >= 0`, which always passes. It only proves the route returned JSON. For an embedding smoke test, send a unique message, wait for the embedding job to complete, then require at least one result containing that message/channel.
- The acceptance checklist uses `/tmp/summary.txt` for headers with `curl -D - -o /tmp/summary.txt`, then greps headers from the body file. Capture headers to a separate file.
- The e2e test recommendation is fine as optional, but Playwright/browser dependencies are substantial offline artifacts. Do not make them part of the core installer unless you intentionally stage them.

## Additional Pre-Ship Checks I Recommend

- Run `docker compose -f docker-compose.enclave.yml config` in staging and save the rendered output as a release artifact.
- On an internet-disabled staging host, run the exact enclave installer from a clean checkout plus image tars.
- Run `docker compose pull --ignore-pull-failures` nowhere in the enclave path; any pull attempt should be treated as a packaging bug.
- Verify no container is configured with public registry image references that are not preloaded.
- Verify all published ports bind only as intended for the enclave proxy model.
- Add a disk-space preflight for image loads, Postgres volume, and backups.
- Add a version endpoint or install report that records git commit, image digests, migration status, and env-derived model names.
- Test a stale or wrong `LLM_BASE_URL` failure path and confirm the installer fails early with a useful message.
- Test wrong `EMBEDDING_DIMENSION` and confirm the failure is caught before go-live.
- Test that disabling vLLM or blocking egress to non-vLLM internal hosts behaves as expected.
- Run `npm audit --omit=dev` in staging before image build, not in the air-gapped enclave unless npm advisory data is mirrored.
- Build the frontend and scan `dist` for unexpected absolute URLs as the punchlist suggests.

## Suggested Revised Release Gates

1. Root env examples fixed and enclave env template added.
2. Enclave Compose/override committed and rendered successfully.
3. Backend Docker image includes required maintenance scripts or the runbook keeps host-side scripts as an explicit offline artifact.
4. Offline images built with stable versioned tags and checksums.
5. Installer runs to completion on a clean no-internet staging host.
6. vLLM generation, streaming, embeddings, and app AI flows pass against real GPU infrastructure.
7. Backup and restore tested.
8. Docker log rotation active.
9. Healthcheck uses `/health/live`.
10. Post-install acceptance checklist passes with meaningful semantic-search and AI assertions.

## Bottom Line

The application itself looks close to enclave-ready. The shipment plan is not yet installer-ready. The biggest change needed is to turn the punchlist's intended topology into actual versioned artifacts: an enclave Compose file, stable preloaded image tags, a real installer, a single enclave env template, and tested backup/restore. Once those exist and vLLM is proven on real hardware, this can plausibly meet the "walk through install, set config variables, product works" bar.
