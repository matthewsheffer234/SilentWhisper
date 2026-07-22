#!/usr/bin/env bash
# scripts/backup-db.sh — docs/plans/active/SHIPMENT_PLAN.md Section 2.5. Dumps the running
# Postgres database in pg_dump's custom format (-Fc: compressed,
# parallelizable restore, restorable into a differently-named database via
# pg_restore -d — unlike plain SQL, which bakes in `\connect <original
# name>` and CREATE DATABASE statements that fight a restore-into-a-new-name
# workflow).
#
# Does NOT parse .env directly (the punchlist draft's `source <(grep -v
# '^#' .env | ...)` breaks on any secret containing a shell-meaningful
# character — quotes, $, backticks). Reads credentials from Compose's own
# already-parsed environment inside the running postgres container instead.
#
# Usage: scripts/backup-db.sh [output-file]
#   Default output: backups/silent_whisper-<UTC timestamp>.dump
#
# Requires the postgres service already up (docker compose up -d postgres).
# Read-only — never touches the live database's data, only reads it.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.enclave.yml)

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

if [ -z "$("${COMPOSE[@]}" ps postgres --status running -q)" ]; then
  fail "postgres is not running (docker compose up -d postgres first)"
fi

POSTGRES_USER=$("${COMPOSE[@]}" exec -T postgres printenv POSTGRES_USER)
POSTGRES_DB=$("${COMPOSE[@]}" exec -T postgres printenv POSTGRES_DB)
if [ -z "$POSTGRES_USER" ] || [ -z "$POSTGRES_DB" ]; then
  fail "could not read POSTGRES_USER/POSTGRES_DB from the running postgres container"
fi

OUT="${1:-backups/${POSTGRES_DB}-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$OUT")"
[ -e "$OUT" ] && fail "refusing to overwrite existing file: $OUT"

log "Dumping database '$POSTGRES_DB' (custom format) to $OUT ..."
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT"

size=$(du -h "$OUT" | cut -f1)
log "Backup written: $OUT ($size)"
log "Contains real application data (user emails, bcrypt password hashes, message content) — handle and store this file with the same care as a database credential, never commit it (backups/ is gitignored), and delete copies you no longer need."
log "Restore with: scripts/restore-db.sh $OUT [target-db-name]"
