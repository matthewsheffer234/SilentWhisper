#!/usr/bin/env bash
# Scripts the manual rebuild-recreate-reload sequence RUNBOOK.md's
# Production Deployment section already documents by hand
# (FEATURE_REQUEST.md "the deploy loop" entry, 2026-07-18). Doesn't change
# what happens — just removes the human-memory dependency that's caused the
# recurring "stale container serving old code" bug class logged repeatedly
# in PROJECT_PLAN.md Section 11.
#
# Usage: scripts/deploy.sh [--reload-nginx]
set -euo pipefail

# Always run from the repo root regardless of the caller's cwd — `docker
# compose` needs docker-compose.yml in its working directory, and every
# other script in this directory is invoked as `cd scripts && node ...`,
# which would otherwise silently break this one.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

reload_nginx=0
for arg in "$@"; do
  case "$arg" in
    --reload-nginx)
      reload_nginx=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--reload-nginx]" >&2
      exit 1
      ;;
  esac
done

echo "==> Building backend and frontend images..."
docker compose build backend frontend

echo "==> Recreating backend and frontend containers..."
docker compose up -d backend frontend

if [ "$reload_nginx" -eq 1 ]; then
  # Recreating a container gives it a new IP; nginx resolves proxy_pass
  # hostnames once and won't notice until reloaded (RUNBOOK.md, "After
  # rebuilding backend or frontend, reload nginx") — needed whenever the
  # public whisper.silentlattice.dev URL is what you're testing against.
  # Deliberately opt-in, not run unconditionally on every deploy: this
  # touches wireservice-nginx-1, shared infrastructure that also fronts
  # silentlattice.dev and dev.silentlattice.dev (RUNBOOK.md, Production
  # Deployment) — most deploys don't need it, and reloading shared
  # infrastructure is worth being deliberate about.
  echo "==> Reloading wireservice-nginx-1..."
  docker exec wireservice-nginx-1 nginx -s reload
else
  echo "==> Skipping nginx reload (pass --reload-nginx if whisper.silentlattice.dev needs to pick up the new containers)."
fi

echo "==> Done."
