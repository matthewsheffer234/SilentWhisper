# Air-Gapped Enclave Readiness Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
Offline readiness assessment: **Application-ready, shipment process still partially tracked**. No runtime CDN, external asset, public AI API, telemetry SDK, or remote webfont dependency was found in application source. The repository now includes an enclave Compose override, image-build script, install script, checksum verification, vLLM checks, log rotation, and reverse-proxy template.

The remaining readiness gaps are already tracked in `docs/plans/active/SHIPMENT_PLAN.md`: the literal installer has not been rehearsed end-to-end on a clean separate host, and vLLM real-hardware verification was accepted as a risk pending actual enclave hardware. These are not rediscovered defects, but they remain operational blockers for a final No-Go/Go decision.

---

## Findings Matrix

| Severity | Category | Finding / Risk | Location |
|---|---|---|---|
| Medium | Installer Rehearsal | Literal one-shot installer still needs a clean-host end-to-end run | `docs/plans/active/SHIPMENT_PLAN.md:69` |
| Medium | vLLM Hardware | Real vLLM hardware verification remains blocked and risk-accepted | `docs/plans/active/SHIPMENT_PLAN.md:80` |
| Low | Build Artifact Portability | Frontend image is intentionally enclave-hostname-specific | `scripts/build-release-images.sh:27` |

---

## Detailed Findings & Remediations

### [ENCLAVE-01] Installer Has Not Been Proven As A Literal Clean-Host Run
- **Severity**: Medium
- **Category**: Installer Rehearsal
- **Location**: `docs/plans/active/SHIPMENT_PLAN.md:L69-L70`, `scripts/airgap-install.sh:L44-L53`
- **Risk Scenario**: The plan records that installer phase logic was exercised, but the unmodified script was not run start-to-finish on a separate host because this host also runs production and has port collisions. In a zero-internet enclave, the first literal run is where Compose merge behavior, host utilities, image tags, port availability, and first-admin/smoke-test flow meet.
- **Recommended Remediation**:
  ```bash
  COMPOSE_PROJECT_NAME=silentwhisper-enclave-rehearsal \
  ENV_FILE=.env.enclave.rehearsal \
  SILENTWHISPER_VERSION=1.6.0 \
    ./scripts/airgap-install.sh
  ```

### [ENCLAVE-02] vLLM Real-Hardware Verification Is Still An Accepted Risk
- **Severity**: Medium
- **Category**: Offline Model & AI Adapter Isolation
- **Location**: `docs/plans/active/SHIPMENT_PLAN.md:L80-L80`, `scripts/airgap-install.sh:L233-L411`
- **Risk Scenario**: The installer now contains model-list, completion, streaming, embedding-dimension, and concurrency checks, but the plan marks real hardware as blocked/risk accepted. Until those checks pass against the actual enclave vLLM hosts, the app can be installed while AI generation or embeddings remain unavailable.
- **Recommended Remediation**:
  ```bash
  # Run before operator sign-off on the actual enclave network.
  ./scripts/airgap-install.sh
  # Require Phase F pass lines in install-report-*.txt.
  ```

### [ENCLAVE-03] Frontend Artifacts Are Hostname-Specific
- **Severity**: Low
- **Category**: Build Artifact Portability
- **Location**: `scripts/build-release-images.sh:L27-L33`, `scripts/airgap-install.sh:L152-L161`
- **Risk Scenario**: Vite bakes `VITE_API_URL` and `VITE_WS_URL` into the frontend bundle. The install script correctly verifies the expected URL, but any hostname change requires rebuilding and re-staging the frontend image. This is documented, not a hidden defect, but it is an operational constraint.
- **Recommended Remediation**:
  ```js
  // Future: serve /config.js from nginx container startup env so one frontend
  // image can be reused across enclave hostnames.
  window.__SILENT_WHISPER_CONFIG__ = {
    apiUrl: process.env.VITE_API_URL,
    wsUrl: process.env.VITE_WS_URL,
  };
  ```

## Architectural Wins & Compliant Offline Patterns
- `docker-compose.enclave.yml` removes Ollama, source builds, and the external `wireservice_default` network.
- `scripts/build-release-images.sh` creates versioned image tars and checksums.
- `scripts/airgap-install.sh` verifies checksums, pgvector, grants, vLLM models, CORS, LLM origins, and backend health without host-side Python.
- Application source has no runtime CDN, Google Fonts, remote image, telemetry, OpenAI, or Hugging Face calls.
