# 2026-07-26 Enclave Readiness Review

Prompt: `docs/code-review-prompts.md` -> Enclave Readiness & Offline Deployment Review.

Scope reviewed from current source: Compose base/override, release image build script, install/upgrade scripts, env templates, nginx enclave template, frontend external references, and operational docs.

## Findings

### Medium: clean-host install evidence is still operational, not source-verifiable

`scripts/airgap-install.sh` is substantially complete: it validates prerequisites, env placeholders, image tars/checksums, frontend URL baking, pgvector, migrations, grants, vLLM model presence, provider auth failure mode, streaming, embedding dimension, concurrency/latency, app health, smoke-test AI summarize, and audit-chain verification (`scripts/airgap-install.sh:90-188`, `scripts/airgap-install.sh:233-375`). The README still records that the script has not been run start-to-finish as one continuous clean-host process (`README.md:33-36`).

This is now an evidence gap rather than a script-design gap. Before relying on the installer as a release gate, run it on a disposable host with staged image artifacts and archive the generated `install-report-*`.

### Medium: real vLLM hardware remains the first proof of provider behavior

The code has explicit installer-time probes for model listing, completion, streaming SSE parsing, embedding dimensions, and concurrent completion latency (`scripts/airgap-install.sh:233-375`). The README still documents that mocked vLLM tests are the only pre-ship proof available on this host (`README.md:35`).

That is the right place to fail closed, but the first real enclave install still carries operational risk: model naming, gateway auth, streaming shape, and latency are discovered at install time rather than during local CI.

### Low: frontend images remain hostname-specific

`scripts/build-release-images.sh` documents and enforces that `VITE_API_URL` and `VITE_WS_URL` are baked into the frontend bundle at build time (`scripts/build-release-images.sh:27-43`, `scripts/build-release-images.sh:56-72`). The installer checks the loaded bundle for the expected API URL before continuing (`scripts/airgap-install.sh:152-161`).

This is an accepted v1 tradeoff, but it means one frontend image cannot be moved between enclave hostnames by changing `.env` alone. A runtime-served config document would remove the need to rebuild the frontend per enclave.

## Verified Controls

- `docker-compose.enclave.yml` removes local Ollama, source builds, and the external `wireservice_default` network; backend/frontend/migrate use prebuilt image tags.
- Release artifacts are versioned tars with `CHECKSUMS.sha256`, and build output is immediately self-verified (`scripts/build-release-images.sh:80-93`).
- `.env.enclave.example` removes dead GitHub/HuggingFace token placeholders and uses vLLM/enclave host placeholders.
- The nginx template preserves WebSocket upgrade headers, forwarded client/protocol headers, HTTPS redirect, and SPA fallback.
- Source grep found no runtime CDN/font dependencies in `frontend/src`; theme preference is the only intentional `localStorage` usage.
- Upgrade flow is data-preserving by design: pre-upgrade backup, no destructive database operations, major-version confirmation, and rollback instructions after failed bring-up (`scripts/airgap-upgrade.sh:29-52`, `scripts/airgap-upgrade.sh:84-110`).
