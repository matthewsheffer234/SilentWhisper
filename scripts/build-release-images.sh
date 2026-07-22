#!/usr/bin/env bash
# scripts/build-release-images.sh — docs/plans/active/SHIPMENT_PLAN.md Section 1.2: the
# versioned, checksummed offline image contract. Run on the networked
# staging/build host, from a clean checkout at the release tag — never on
# the air-gapped enclave itself. Produces exactly the artifact set
# scripts/airgap-install.sh's Phase A/B already expect:
#   images/postgres-pgvector-pg16.tar
#   images/silentwhisper-backend-<version>.tar
#   images/silentwhisper-frontend-<version>.tar
#   images/CHECKSUMS.sha256
#
# Does NOT use `docker compose -f docker-compose.yml -f
# docker-compose.enclave.yml build backend frontend`, despite that being
# Section 1.2's original example command — verified empirically (2026-07-22)
# that this silently no-ops: docker-compose.enclave.yml's `build: !reset
# null` on backend/frontend/migrate (Section 1.1, so the enclave file can
# never accidentally trigger a source build) means the merged config has no
# `build:` section left for `compose build` to act on, and `compose build`
# treats "no build config" as nothing-to-do rather than an error — exit 0,
# zero images produced. The enclave file's own `build: !reset null` comment
# already says "build/tag/save those before this file is usable"; this
# script does the building against the BASE file (which still has
# `build:`), then tags the result with the exact tags the enclave file
# references. The two files' jobs stay separate: base file builds, enclave
# file only ever references pre-built, pre-tagged images.
#
# Frontend build-time URL decision (Section 1.2, "ships now"): the frontend
# bundle bakes VITE_API_URL/VITE_WS_URL in at build time (Vite inlines
# import.meta.env.VITE_*), so a frontend image is only ever valid for the
# one enclave hostname it was built against — this script must be re-run
# per enclave for the frontend image specifically (backend and postgres are
# enclave-agnostic and only need building once per release). See
# RUNBOOK.md's "Enclave Image Build" section.
#
# Required env vars (from a real release .env — see .env.enclave.example):
#   VITE_API_URL, VITE_WS_URL          — this enclave's real browser-facing origin
# Optional:
#   SILENTWHISPER_VERSION (default 1.0.0) — must match what
#     docker-compose.enclave.yml's SILENTWHISPER_VERSION resolves to at
#     install time, and what scripts/airgap-install.sh is run with.
#   TASK_OWNER_TOKEN_ALIAS (default owner) — baked into the frontend as
#     VITE_TASK_OWNER_TOKEN_ALIAS; must match the enclave's backend env value
#     (docker-compose.yml's own frontend.build.args does the same reuse).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${SILENTWHISPER_VERSION:-1.0.0}"
POSTGRES_IMAGE="pgvector/pgvector:pg16"
BACKEND_TAG="silentwhisper-backend:${VERSION}"
FRONTEND_TAG="silentwhisper-frontend:${VERSION}"

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker CLI not found"
docker info >/dev/null 2>&1 || fail "docker daemon not reachable"
[ -n "${VITE_API_URL:-}" ] || fail "VITE_API_URL not set — this enclave's real browser-facing API origin (e.g. https://enclave-host/api), not localhost"
[ -n "${VITE_WS_URL:-}" ]  || fail "VITE_WS_URL not set — this enclave's real browser-facing WS origin (e.g. wss://enclave-host/ws)"

log "Building backend/migrate image (context: repo root, backend/Dockerfile) as ${BACKEND_TAG}"
docker build -f backend/Dockerfile -t "${BACKEND_TAG}" .

log "Building frontend image (context: frontend/) as ${FRONTEND_TAG}"
log "  VITE_API_URL=${VITE_API_URL}  VITE_WS_URL=${VITE_WS_URL}  VITE_TASK_OWNER_TOKEN_ALIAS=${TASK_OWNER_TOKEN_ALIAS:-owner}"
docker build \
  -f frontend/Dockerfile \
  --build-arg "VITE_API_URL=${VITE_API_URL}" \
  --build-arg "VITE_WS_URL=${VITE_WS_URL}" \
  --build-arg "VITE_TASK_OWNER_TOKEN_ALIAS=${TASK_OWNER_TOKEN_ALIAS:-owner}" \
  -t "${FRONTEND_TAG}" \
  ./frontend

log "Pulling ${POSTGRES_IMAGE} (staging host only — the enclave never fetches this itself)"
docker pull "${POSTGRES_IMAGE}"

mkdir -p images
rm -f images/postgres-pgvector-pg16.tar "images/silentwhisper-backend-${VERSION}.tar" "images/silentwhisper-frontend-${VERSION}.tar"

log "Saving image tars to images/"
docker save "${POSTGRES_IMAGE}" -o images/postgres-pgvector-pg16.tar
docker save "${BACKEND_TAG}"    -o "images/silentwhisper-backend-${VERSION}.tar"
docker save "${FRONTEND_TAG}"   -o "images/silentwhisper-frontend-${VERSION}.tar"

log "Writing checksums"
( cd "$(pwd)" && sha256sum \
    images/postgres-pgvector-pg16.tar \
    "images/silentwhisper-backend-${VERSION}.tar" \
    "images/silentwhisper-frontend-${VERSION}.tar" \
    > images/CHECKSUMS.sha256 )

log "Verifying checksum file against what was just written"
sha256sum -c images/CHECKSUMS.sha256 || fail "checksum self-verification failed immediately after writing — something is wrong with this script, not just the artifacts"

log "Done. images/CHECKSUMS.sha256:"
cat images/CHECKSUMS.sha256
log "SILENTWHISPER_VERSION=${VERSION} — pass the same value to scripts/airgap-install.sh on the enclave host (its default is also ${VERSION}; only pass it explicitly if this release used a different version)."
