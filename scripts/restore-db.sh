#!/usr/bin/env bash
# scripts/restore-db.sh — SHIPMENT_PLAN.md Section 2.5. Restores a
# scripts/backup-db.sh dump into a NEW, distinctly-named database on the
# same running Postgres instance — never into the original database name,
# and never by dropping/overwriting anything. Verifying a backup is
# restorable should not require (and must never risk) touching the live
# database it came from.
#
# Validates the target database name against a strict allowlist BEFORE it
# ever reaches SQL — the punchlist draft's `CREATE DATABASE ${TARGET_DB};`
# interpolated the argument directly, which is SQL injection via a shell
# argument if TARGET_DB isn't constrained first.
#
# Usage: scripts/restore-db.sh <dump-file> [target-db-name]
#   Default target-db-name: silent_whisper_restored_<unix timestamp>
#
# Requires the postgres service already up. Grants: pg_dump's custom format
# includes each object's ACLs (GRANT statements) by default, so a restored
# database should already have app_runtime_user's grants intact without
# re-running database/migrations/0007_grants.js — verify this rather than
# assuming it (see RUNBOOK.md's Enclave section / SHIPMENT_PLAN.md Section
# 2.7 for the expected per-table grant matrix to check against).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.enclave.yml)

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

DUMP_FILE="${1:?Usage: scripts/restore-db.sh <dump-file> [target-db-name]}"
[ -f "$DUMP_FILE" ] || fail "dump file not found: $DUMP_FILE"

TARGET_DB="${2:-silent_whisper_restored_$(date +%s)}"
# Strict allowlist: letters/digits/underscore, must start with a letter or
# underscore. Also caps length at Postgres's own 63-byte identifier limit —
# a name that passes the character check but is too long would otherwise
# fail deep inside CREATE DATABASE with a less obvious error.
[[ "$TARGET_DB" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || fail "invalid target database name: '$TARGET_DB' (letters, digits, underscore only, must start with a letter or underscore)"
[ "${#TARGET_DB}" -le 63 ] || fail "target database name too long (${#TARGET_DB} chars, Postgres identifier limit is 63): '$TARGET_DB'"

if [ -z "$("${COMPOSE[@]}" ps postgres --status running -q)" ]; then
  fail "postgres is not running (docker compose up -d postgres first)"
fi

POSTGRES_USER=$("${COMPOSE[@]}" exec -T postgres printenv POSTGRES_USER)
[ -n "$POSTGRES_USER" ] || fail "could not read POSTGRES_USER from the running postgres container"

existing=$("${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB';")
[ -z "$existing" ] || fail "database '$TARGET_DB' already exists — this script only ever creates a new database, never drops or overwrites one; pick a different name"

log "Creating database '$TARGET_DB' ..."
"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"${TARGET_DB}\";" >/dev/null

log "Restoring $DUMP_FILE into '$TARGET_DB' ..."
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" < "$DUMP_FILE"

log "Restore complete: database '$TARGET_DB'."
log "This is a standalone copy — nothing above touched the database the dump was taken from."
log "Sanity checks worth running against it: row counts vs. the source, scripts/verify-audit-log.mjs (PGDATABASE=$TARGET_DB), and idx_message_embeddings_hnsw's indisvalid status if semantic search matters for this restore."
log "When done verifying, drop it: docker compose exec -T postgres psql -U $POSTGRES_USER -d postgres -c 'DROP DATABASE \"$TARGET_DB\";'"
