#!/usr/bin/env bash
# scripts/airgap-upgrade.sh — upgrades an already-installed Silent Whisper
# enclave to a new SILENTWHISPER_VERSION, preserving all existing data.
# Sibling to scripts/airgap-install.sh, not a variant of it: this script
# assumes Postgres already exists and holds real data, that accounts already
# exist, and it must never do anything install-only (create the database,
# run interactive first-admin creation, leave a smoke-test workspace
# behind). See CHANGELOG.md for the versioning scheme this depends on
# (MINOR releases are always additive/non-destructive migrations; MAJOR
# releases require the operator's own read of that version's CHANGELOG
# entry before this script will proceed) and RUNBOOK.md's "Enclave Upgrade"
# section for the full walkthrough.
#
# Exits non-zero on the first failure (set -euo pipefail), same as
# airgap-install.sh. Deliberately duplicates a handful of that script's
# phases (image loading, migrate, grants-verify) rather than sourcing a
# shared lib — same "each script is standalone, matching style, no shared
# lib" precedent scripts/backup-db.sh/restore-db.sh already established,
# chosen over refactoring airgap-install.sh (already verified end-to-end
# against real infrastructure — docs/plans/active/SHIPMENT_PLAN.md) for a
# second caller and risking that verification.
#
# Required: a real Silent Whisper install already running (docker compose ps
# shows postgres/backend/frontend up), a real .env with SILENTWHISPER_VERSION
# already bumped to the target version, and images/ staged for that new
# version (same offline image contract Section 1.2 / scripts/build-release-
# images.sh already produces — this script does not build anything, ever).
#
# What this script does that airgap-install.sh does not:
#   1. Takes a full pg_dump backup BEFORE touching anything else (Phase B) —
#      SKIP_BACKUP=1 exists only for rehearsal against a throwaway stack,
#      never for a real enclave; skipping it on a real upgrade is asking to
#      lose the one thing that makes a bad upgrade recoverable.
#   2. Refuses to proceed on a MAJOR version bump without
#      CONFIRM_MAJOR_UPGRADE=1 — CHANGELOG.md's own versioning rule is that
#      MAJOR means "something here needs the operator's own read and manual
#      step," and this script has no way to know what that step is; it can
#      only make sure nobody runs through one unattended.
#   3. Never touches Postgres itself beyond running migrations — no
#      `docker compose up postgres` from scratch, no CREATE EXTENSION, no
#      grants migration (0007) reapplication. It's already there.
#   4. On any failure after new containers come up, prints the exact
#      rollback recipe (previous image tags, the backup just taken) instead
#      of just exiting.
#
# What this script deliberately does NOT do (same list as airgap-install.sh,
# repeated because it matters equally here):
#   - Does not generate secrets.
#   - Does not touch any reverse proxy or certificate.
#   - Does not run `docker compose down -v`, `migrate:rollback`, `DROP
#     DATABASE`, or any other destructive operation under any flag.
#   - Does not build any image — loads pre-built tars only, never --build.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.enclave.yml)
REPORT_FILE="upgrade-report-$(date +%Y%m%d-%H%M%S).txt"
BACKUP_FILE=""
PREVIOUS_VERSION=""
STARTED_BRINGING_UP_NEW_VERSION=0
# Resolved once $ENV_FILE is sourced in phase_preflight (BACKEND_HOST_PORT
# is unset until then, same as every other var this script reads from it).
# docker-compose.yml's own backend port binding is already
# ${BACKEND_HOST_PORT:-8101} — this script hardcoding plain :8101 regardless
# was a latent bug found while rehearsing against an isolated stack on a
# host that already had a real deployment bound to the default port: with
# BACKEND_HOST_PORT remapped so the rehearsal stack could even start, every
# curl call below would have silently queried the OTHER, real backend
# instead of failing loudly — a false-positive/false-negative risk, not
# just an inconvenience. BASE_URL is computed fresh (not cached) so it
# reflects whatever $ENV_FILE actually set.
BASE_URL=""

log()    { echo "==> $*"; }
report() { echo "$*" >> "$REPORT_FILE"; }
pass()   { log "PASS: $*"; report "PASS: $*"; }
fail()   { echo "FAIL: $*" >&2; report "FAIL: $*"; exit 1; }

backend_image()  { echo "silentwhisper-backend:${SILENTWHISPER_VERSION:-1.0.0}"; }
frontend_image() { echo "silentwhisper-frontend:${SILENTWHISPER_VERSION:-1.0.0}"; }

# Fires on any exit (including `fail`'s explicit `exit 1`, via set -e's
# propagation into the trap). Only prints rollback guidance once new
# containers have actually started coming up — a failure during preflight
# or the backup itself leaves the running enclave completely untouched, so
# there is nothing to roll back and saying so would be actively misleading.
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$STARTED_BRINGING_UP_NEW_VERSION" -eq 1 ]; then
    echo "" >&2
    echo "==================== UPGRADE FAILED — ROLLBACK ====================" >&2
    echo "The new backend/frontend containers may be up but unhealthy, or" >&2
    echo "something after that point failed. Postgres itself was never" >&2
    echo "touched beyond running migrations (additive-only, per" >&2
    echo "CHANGELOG.md's versioning rule), so your data is intact either way." >&2
    echo "" >&2
    echo "To roll back to the previous version:" >&2
    echo "  1. ${COMPOSE[*]} up -d --no-deps \\" >&2
    echo "       backend frontend" >&2
    echo "     ... after first editing $ENV_FILE to set" >&2
    echo "     SILENTWHISPER_VERSION=${PREVIOUS_VERSION:-<the previous version — check upgrade-report-*.txt from the prior install/upgrade>}" >&2
    echo "     (the previous images are still loaded locally under that tag" >&2
    echo "     unless something pruned them — confirm with: docker images" >&2
    echo "     | grep silentwhisper)." >&2
    if [ -n "$BACKUP_FILE" ]; then
      echo "  2. Only if the running database itself looks wrong (should not" >&2
      echo "     happen — migrations this script runs are additive-only):" >&2
      echo "     restore $BACKUP_FILE with scripts/restore-db.sh into a new" >&2
      echo "     database, verify it, and only then decide whether to point" >&2
      echo "     the app at it — restore-db.sh never overwrites the live" >&2
      echo "     database itself, by design." >&2
    fi
    echo "=====================================================================" >&2
    report ""
    report "UPGRADE FAILED. Rollback guidance printed to stderr above."
  fi
}
trap on_exit EXIT

phase_preflight() {
  log "Phase A: pre-flight checks"

  command -v docker >/dev/null || fail "docker CLI not found"
  docker info >/dev/null 2>&1 || fail "docker daemon not reachable"
  docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin not found"
  command -v curl >/dev/null || fail "curl not found"
  command -v sha256sum >/dev/null || fail "sha256sum not found"
  pass "host prerequisites present"

  [ -f "$ENV_FILE" ] || fail "$ENV_FILE missing"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  pass "$ENV_FILE loaded"

  BASE_URL="http://localhost:${BACKEND_HOST_PORT:-8101}"
  report "Backend base URL: $BASE_URL"

  [ -n "$("${COMPOSE[@]}" ps postgres --status running -q)" ] \
    || fail "postgres is not running — this script upgrades an existing install, it does not create one. Use scripts/airgap-install.sh for a fresh install."
  [ -n "$("${COMPOSE[@]}" ps backend --status running -q)" ] \
    || fail "backend is not running — an upgrade needs a running instance to read the current version from (GET /health) and to leave in a known state on failure. If the enclave is genuinely down, bring it up on its current version first."
  pass "existing install is up (postgres, backend both running)"

  local current_health
  current_health=$(curl -sf "$BASE_URL/health") || fail "could not reach the running backend's /health — cannot determine the current version"
  # Regex, not a JSON parser: deliberately avoids the docker-run-a-node-
  # container trick airgap-install.sh's json_field() uses for this one
  # value, since that trick resolves the image to check via
  # SILENTWHISPER_VERSION — which at this point in the script is already the
  # *new* target version from $ENV_FILE, not the currently-running one. The
  # /health response shape is simple and stable enough not to need a real
  # parser for a single flat string field.
  PREVIOUS_VERSION=$(echo "$current_health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ -z "$PREVIOUS_VERSION" ]; then
    # Expected exactly once, ever: v1.0.0 predates GET /health reporting a
    # version at all (that field shipped in 1.1.0), so the very first
    # upgrade any real enclave ever runs will always hit this branch. Not
    # guessed automatically — the operator has to explicitly assert what
    # they believe is running, same "fail closed, make the operator say it
    # out loud" posture as CONFIRM_MAJOR_UPGRADE above.
    [ -n "${ASSUME_PREVIOUS_VERSION:-}" ] \
      || fail "the running backend's /health has no version field. This is expected only for the very first upgrade off v1.0.0 (GET /health didn't report version until v1.1.0 — see CHANGELOG.md). If that's what's running, confirm it explicitly: re-run with ASSUME_PREVIOUS_VERSION=1.0.0. If a version field is genuinely missing on a build that should have one, something else is wrong — do not guess."
    PREVIOUS_VERSION="$ASSUME_PREVIOUS_VERSION"
    log "No version field in /health — proceeding with operator-confirmed ASSUME_PREVIOUS_VERSION=$PREVIOUS_VERSION"
  fi
  report "Previous version (currently running): $PREVIOUS_VERSION"
  pass "current running version: $PREVIOUS_VERSION"

  [ -n "${SILENTWHISPER_VERSION:-}" ] || fail "$ENV_FILE has no SILENTWHISPER_VERSION set — set it to the new version being installed before running this script (see CHANGELOG.md)"
  [ "$SILENTWHISPER_VERSION" != "$PREVIOUS_VERSION" ] \
    || fail "$ENV_FILE's SILENTWHISPER_VERSION ($SILENTWHISPER_VERSION) is the same as what's already running — nothing to upgrade. Bump it to the new target version first."
  report "Target version: $SILENTWHISPER_VERSION"
  pass "target version ($SILENTWHISPER_VERSION) differs from the running version ($PREVIOUS_VERSION)"

  local prev_major target_major
  prev_major="${PREVIOUS_VERSION%%.*}"
  target_major="${SILENTWHISPER_VERSION%%.*}"
  if [ "$prev_major" != "$target_major" ] && [ "${CONFIRM_MAJOR_UPGRADE:-0}" != "1" ]; then
    fail "this is a MAJOR version bump ($PREVIOUS_VERSION -> $SILENTWHISPER_VERSION). Per CHANGELOG.md's versioning rule, a MAJOR release always requires a manual step this script cannot know about or perform — read that version's CHANGELOG.md entry in full first, then re-run with CONFIRM_MAJOR_UPGRADE=1 once you've done whatever it calls for."
  fi
  if [ "$prev_major" = "$target_major" ]; then
    pass "MINOR/PATCH upgrade ($PREVIOUS_VERSION -> $SILENTWHISPER_VERSION) — no manual CHANGELOG step expected"
  else
    pass "MAJOR upgrade confirmed via CONFIRM_MAJOR_UPGRADE=1 ($PREVIOUS_VERSION -> $SILENTWHISPER_VERSION) — proceeding on the assumption its manual step was already done"
  fi

  for img in \
    "images/silentwhisper-backend-${SILENTWHISPER_VERSION}.tar" \
    "images/silentwhisper-frontend-${SILENTWHISPER_VERSION}.tar"
  do
    [ -f "$img" ] || fail "$img not found — stage the offline image bundle for the new version first (scripts/build-release-images.sh on a networked staging host, then transfer)"
  done
  [ -f images/CHECKSUMS.sha256 ] || fail "images/CHECKSUMS.sha256 not found"
  pass "offline image tars for ${SILENTWHISPER_VERSION} + checksum manifest present"

  if [ -n "${LLM_BASE_URL:-}" ]; then
    log "Checking vLLM host reachability: ${LLM_BASE_URL} (lightweight — full round-trip/streaming checks are airgap-install.sh's job, not a routine upgrade's)"
    curl -sf --max-time 5 "${LLM_BASE_URL}/v1/models" -H "Authorization: Bearer ${LLM_API_KEY:-}" >/dev/null \
      || fail "vLLM host ${LLM_BASE_URL} is not reachable on /v1/models — this upgrade doesn't change vLLM configuration, so if it was working before this upgrade, confirm nothing else changed"
    pass "vLLM host reachable"
  fi
}

phase_backup() {
  if [ "${SKIP_BACKUP:-0}" = "1" ]; then
    log "SKIP_BACKUP=1 — skipping the pre-upgrade backup. NEVER do this against a real enclave; this exists only for rehearsal against a throwaway stack."
    return
  fi

  log "Phase B: pre-upgrade backup (mandatory — this is the actual rollback mechanism)"
  BACKUP_FILE="backups/pre-upgrade-${PREVIOUS_VERSION}-to-${SILENTWHISPER_VERSION}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  ./scripts/backup-db.sh "$BACKUP_FILE" || fail "pre-upgrade backup failed — refusing to continue without one"
  pass "backup written: $BACKUP_FILE"
  report "Backup file: $BACKUP_FILE"
}

phase_load_images() {
  log "Phase C: verify checksums and load the new offline images"

  sha256sum -c images/CHECKSUMS.sha256 || fail "checksum verification failed for one or more staged image tars — re-stage from a trusted source before continuing"
  pass "tar checksums verified"

  docker load -i "images/silentwhisper-backend-${SILENTWHISPER_VERSION}.tar"
  docker load -i "images/silentwhisper-frontend-${SILENTWHISPER_VERSION}.tar"

  docker image inspect "$(backend_image)" >/dev/null 2>&1 \
    || fail "$(backend_image) not present after docker load — check the tar was built with this exact tag"
  docker image inspect "$(frontend_image)" >/dev/null 2>&1 \
    || fail "$(frontend_image) not present after docker load"
  pass "new images loaded and expected tags verified present"

  report "  new backend image:  $(backend_image)  id=$(docker image inspect -f '{{.Id}}' "$(backend_image)")"
  report "  new frontend image: $(frontend_image)  id=$(docker image inspect -f '{{.Id}}' "$(frontend_image)")"
}

phase_frontend_bundle_check() {
  log "Verifying the new frontend bundle was baked for this enclave's URLs"
  [ -n "${VITE_API_URL:-}" ] || fail "$ENV_FILE has no VITE_API_URL set"
  local hits
  hits=$(docker run --rm --entrypoint sh "$(frontend_image)" -c \
    "grep -Fl '${VITE_API_URL}' /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l") || hits=0
  [ "$hits" -gt 0 ] || fail "new frontend bundle does not contain the expected VITE_API_URL (${VITE_API_URL}) — it was built for a different origin and needs rebuilding for this enclave"
  pass "new frontend bundle baked with the expected VITE_API_URL"
}

phase_migrate() {
  log "Phase D: apply migrations (non-destructive — never migrate:rollback here; CHANGELOG.md guarantees every MINOR/PATCH migration is additive)"

  "${COMPOSE[@]}" --profile tools run --rm migrate \
    || fail "migration run failed — the running (old) backend is still up and serving on the old schema, nothing has been torn down"
  "${COMPOSE[@]}" --profile tools run --rm migrate npx knex --knexfile knexfile.js migrate:status
  pass "migrations applied"
}

phase_grants() {
  log "Phase E: re-verify app_runtime_user grants (a new migration may have added a table)"

  local grants
  grants=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "
    SELECT table_name || ':' || string_agg(privilege_type, ',' ORDER BY privilege_type)
    FROM information_schema.role_table_grants
    WHERE grantee = '${APP_DB_USER}'
    GROUP BY table_name ORDER BY table_name;
  ") || fail "could not query app_runtime_user grants"
  report "app_runtime_user grants:"
  report "$grants"

  while IFS=: read -r table privs; do
    [ -z "$table" ] && continue
    case "$table" in
      audit_logs)
        [ "$privs" = "INSERT,SELECT" ] \
          || fail "audit_logs privileges are '$privs', expected 'INSERT,SELECT' only — append-only guarantee is broken"
        ;;
      organizations|users|workspaces|channels|messages)
        [ "$privs" = "INSERT,SELECT,UPDATE" ] \
          || fail "$table privileges are '$privs', expected 'INSERT,SELECT,UPDATE' (no DELETE)"
        ;;
      *)
        [ "$privs" = "DELETE,INSERT,SELECT,UPDATE" ] \
          || fail "$table privileges are '$privs', expected full CRUD — if this is a new table added by this release's migration, check it was granted correctly (RUNBOOK.md's grants matrix)"
        ;;
    esac
  done <<< "$grants"
  pass "app_runtime_user grants match the expected per-table matrix"
}

phase_bring_up_new_version() {
  log "Phase F: bring up backend/frontend on the new images"
  STARTED_BRINGING_UP_NEW_VERSION=1

  # up -d recreates a service whose resolved image changed, same mechanism
  # scripts/deploy.sh already relies on — no explicit stop needed first, and
  # postgres (not listed here) is left completely alone.
  "${COMPOSE[@]}" up -d backend frontend

  timeout 60 bash -c "
    until curl -sf '$BASE_URL/health/live' >/dev/null; do sleep 2; done
  " || fail "backend /health/live did not become reachable within 60s on the new version"
  pass "new backend liveness reachable"

  timeout 90 bash -c "
    until curl -sf '$BASE_URL/health' >/dev/null; do sleep 2; done
  " || fail "backend /health did not become reachable within 90s on the new version"

  local new_health reported_version
  new_health=$(curl -sf "$BASE_URL/health") || fail "could not re-fetch /health after bring-up"
  reported_version=$(echo "$new_health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  [ "$reported_version" = "$SILENTWHISPER_VERSION" ] \
    || fail "backend is up but GET /health reports version '$reported_version', not the expected '$SILENTWHISPER_VERSION' — a stale container may still be serving traffic"
  pass "backend confirms it is actually running the new version ($reported_version)"

  echo "$new_health" | grep -q '"db":"ok"' \
    || fail "backend is up on the new version but reports db not ok"
  pass "backend reports db ok on the new version"

  if echo "$new_health" | grep -q '"ai":{"healthy":true'; then
    pass "backend reports the AI provider healthy on the new version"
  else
    log "backend does not report the AI provider healthy yet — this can be a normal cold-start race with the periodic health sweep (LLM_HEALTH_CHECK_INTERVAL_MS); not treated as a hard failure here. Re-check GET /health after a minute; if it stays false, see RUNBOOK.md's AI Features troubleshooting."
  fi

  "${COMPOSE[@]}" exec -T frontend sh -c "test -f /usr/share/nginx/html/index.html" \
    || fail "new frontend static build missing"
  pass "new frontend static build present"
}

phase_data_repair() {
  log "Phase G: post-upgrade data repair (idempotent — a no-op once already applied, safe to re-run any time)"

  # backfill-sentiment-scores.mjs (v1.3.1): message_sentiment_scores is only
  # ever populated as a side effect of an embedding_jobs row, which is only
  # enqueued at message-creation time — an enclave upgrading past v1.3.0
  # for the first time has real pre-existing messages that were already
  # embedded (and their job rows long gone) before the sentiment feature
  # existed, so nothing would otherwise ever score them. Deliberately not a
  # hard `fail` on error: it depends on the AI provider being reachable, the
  # same kind of transient cold-start race phase_bring_up_new_version's own
  # AI-health check above already tolerates rather than fails on, and it
  # touches no application-critical data — an operator can re-run it any
  # time once the provider is confirmed healthy. Add future one-time
  # data-repair scripts here as they're introduced, same pattern.
  if "${COMPOSE[@]}" exec -T backend node /app/scripts/backfill-sentiment-scores.mjs; then
    pass "post-upgrade data repair complete"
  else
    log "post-upgrade data repair (backfill-sentiment-scores.mjs) failed — not treated as a hard upgrade failure (see this phase's own comment in the script). Re-run manually once the AI provider is confirmed healthy: docker compose exec backend node /app/scripts/backfill-sentiment-scores.mjs"
  fi
}

phase_audit_verify() {
  log "Phase H: verifying audit log hash chain is still intact"
  "${COMPOSE[@]}" exec -T backend node /app/scripts/verify-audit-log.mjs \
    || fail "audit log verification failed after upgrade"
  pass "audit log integrity verified"
}

phase_write_report() {
  {
    echo ""
    echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Upgraded: $PREVIOUS_VERSION -> $SILENTWHISPER_VERSION"
    [ -n "$BACKUP_FILE" ] && echo "Pre-upgrade backup: $BACKUP_FILE"
  } >> "$REPORT_FILE"
  log "Upgrade report written: $REPORT_FILE"
}

main() {
  report "Silent Whisper enclave upgrade report"
  report "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report "Git commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  report "Git describe: $(git describe --tags --always 2>/dev/null || echo unknown)"
  report ""

  phase_preflight
  phase_backup
  phase_load_images
  phase_frontend_bundle_check
  phase_migrate
  phase_grants
  phase_bring_up_new_version
  phase_data_repair
  phase_audit_verify
  phase_write_report

  log ""
  log "Upgrade complete: ${PREVIOUS_VERSION} -> ${SILENTWHISPER_VERSION}. See ${REPORT_FILE} for the full report."
  log "Previous images are still loaded locally (docker images | grep silentwhisper) unless pruned — see CHANGELOG.md for what shipped in ${SILENTWHISPER_VERSION}."
}

main "$@"
