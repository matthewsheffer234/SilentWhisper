#!/usr/bin/env bash
# scripts/airgap-install.sh — one-shot enclave installer for Silent Whisper.
# SHIPMENT_PLAN.md Sections 1.3 (this file) and 4 (the 17-step shape this
# implements). Idempotent-ish: safe to re-run after a partial failure up
# through the point it failed (nothing here is destructive — see "What this
# script deliberately does NOT do" at the bottom). Exits non-zero on the
# first failure (set -euo pipefail) rather than continuing into a partially
# broken state, and every step is logged clearly as it runs.
#
# Corrects several bugs found in this script's earlier draft (folded in from
# SHIPMENT_PUNCHLIST_REVIEW.md via SHIPMENT_PLAN.md Section 1.3) rather than
# re-deriving them:
#   - .env is actually loaded (`set -a; source .env; set +a`) before any
#     variable from it is referenced — the draft checked
#     `${LLM_PROVIDER:-}` etc. directly, which only worked if the operator
#     had separately exported them.
#   - No python3 anywhere. The draft recommended Bash specifically to avoid
#     adding Python as a host dependency, then used `python3 -c` for JSON
#     parsing — a straight contradiction. Every bit of JSON parsing here
#     instead runs inside a throwaway container of the already-loaded
#     backend image (`docker run --rm -i ... node -e "..."`), since Node is
#     already a hard dependency of this stack and this needs nothing new on
#     the host beyond docker/curl/coreutils.
#   - No `--build` anywhere, ever, on any `docker compose` invocation — once
#     docker-compose.enclave.yml uses `image:` instead of `build:`, an
#     accidental build attempt should fail loudly (no Dockerfile/context
#     reachable the way this script runs), not silently succeed by reaching
#     a registry/source tree an air-gapped host doesn't have.
#   - Every `docker compose` call passes both compose files explicitly
#     (`-f docker-compose.yml -f docker-compose.enclave.yml`) via the
#     $COMPOSE array below.
#
# Required env vars (from the enclave's own .env — see .env.enclave.example
# once it exists, SHIPMENT_PLAN.md Section 2.1c): POSTGRES_USER,
# POSTGRES_PASSWORD, POSTGRES_DB, APP_DB_USER, APP_DB_PASSWORD, JWT_SECRET,
# LLM_PROVIDER (must be "vllm"), LLM_BASE_URL, LLM_API_KEY, LLM_MODEL,
# EMBEDDING_MODEL, EMBEDDING_DIMENSION, CORS_ORIGIN, VITE_API_URL,
# VITE_WS_URL. Optional: SILENTWHISPER_VERSION (image tag suffix, default
# 1.0.0 — must match whatever Section 1.2's staging build actually tagged),
# ALLOWED_LLM_ORIGINS (safe to leave unset — config.js falls back to
# LLM_BASE_URL's own origin), SKIP_FIRST_ADMIN=1 (skip interactive
# first-admin creation and the end-to-end smoke test that depends on it).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.enclave.yml)
REPORT_FILE="install-report-$(date +%Y%m%d-%H%M%S).txt"
FIRST_ADMIN_USERNAME=""
FIRST_ADMIN_PASSWORD=""

log()    { echo "==> $*"; }
report() { echo "$*" >> "$REPORT_FILE"; }
pass()   { log "PASS: $*"; report "PASS: $*"; }
fail()   { echo "FAIL: $*" >&2; report "FAIL: $*"; exit 1; }

backend_image() { echo "silentwhisper-backend:${SILENTWHISPER_VERSION:-1.0.0}"; }
frontend_image() { echo "silentwhisper-frontend:${SILENTWHISPER_VERSION:-1.0.0}"; }

# Reads a JSON string from stdin, prints one top-level field. Runs inside the
# already-loaded backend image so this needs no host-side JSON tool beyond
# docker itself (see the python3 note above).
json_field() {
  local field="$1"
  docker run --rm -i "$(backend_image)" node -e "
    let d = '';
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => {
      const j = JSON.parse(d);
      console.log(j['${field}']);
    });
  "
}

phase_preflight() {
  log "Phase A: pre-flight checks"

  command -v docker >/dev/null || fail "docker CLI not found"
  docker info >/dev/null 2>&1 || fail "docker daemon not reachable"
  docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin not found"
  command -v curl >/dev/null || fail "curl not found"
  command -v timeout >/dev/null || fail "timeout (coreutils) not found"
  command -v xargs >/dev/null || fail "xargs not found"
  command -v sha256sum >/dev/null || fail "sha256sum not found"
  pass "host prerequisites present (docker, compose v2, curl, timeout, xargs, sha256sum)"

  [ -f .env ] || fail ".env missing — copy an enclave env template to .env and fill in real values first (SHIPMENT_PLAN.md Section 2.1c)"
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  pass ".env loaded"

  grep -q "your_.*_here" .env && fail ".env still has placeholder values — see RUNBOOK.md First-Time Setup"
  pass "no placeholder values in .env"

  [ "${LLM_PROVIDER:-}" = "vllm" ] || fail "LLM_PROVIDER must be 'vllm' in this enclave's .env — docker-compose.enclave.yml has no local Ollama fallback"
  [ -n "${LLM_BASE_URL:-}" ] || fail "LLM_BASE_URL must point at the enclave's vLLM host (e.g. https://vllm-gpu01.enclave.internal:8000)"
  pass "LLM_PROVIDER=vllm, LLM_BASE_URL set"

  for img in \
    "images/postgres-pgvector-pg16.tar" \
    "images/silentwhisper-backend-${SILENTWHISPER_VERSION:-1.0.0}.tar" \
    "images/silentwhisper-frontend-${SILENTWHISPER_VERSION:-1.0.0}.tar"
  do
    [ -f "$img" ] || fail "$img not found — stage the offline image bundle first (SHIPMENT_PLAN.md Section 1.2)"
  done
  [ -f images/CHECKSUMS.sha256 ] || fail "images/CHECKSUMS.sha256 not found — Section 1.2's staging build must produce this"
  pass "offline image tars + checksum manifest present"

  log "Checking vLLM host reachability: ${LLM_BASE_URL}"
  curl -sf --max-time 5 "${LLM_BASE_URL}/v1/models" >/dev/null \
    || fail "vLLM host ${LLM_BASE_URL} is not reachable on /v1/models — confirm network path, firewall rules, and that vLLM is actually running there before continuing"
  pass "vLLM host reachable"
}

phase_load_images() {
  log "Phase B: verify checksums and load offline images"

  sha256sum -c images/CHECKSUMS.sha256 || fail "checksum verification failed for one or more staged image tars — re-stage from a trusted source before continuing"
  pass "tar checksums verified"

  docker load -i images/postgres-pgvector-pg16.tar
  docker load -i "images/silentwhisper-backend-${SILENTWHISPER_VERSION:-1.0.0}.tar"
  docker load -i "images/silentwhisper-frontend-${SILENTWHISPER_VERSION:-1.0.0}.tar"

  docker image inspect "$(backend_image)" >/dev/null 2>&1 \
    || fail "$(backend_image) not present after docker load — check the tar was built with this exact tag (SILENTWHISPER_VERSION must match Section 1.2's staging build)"
  docker image inspect "$(frontend_image)" >/dev/null 2>&1 \
    || fail "$(frontend_image) not present after docker load"
  docker image inspect pgvector/pgvector:pg16 >/dev/null 2>&1 \
    || fail "pgvector/pgvector:pg16 not present after docker load"
  pass "images loaded and expected tags verified present"

  report "  backend image:  $(backend_image)  id=$(docker image inspect -f '{{.Id}}' "$(backend_image)")"
  report "  frontend image: $(frontend_image)  id=$(docker image inspect -f '{{.Id}}' "$(frontend_image)")"
  report "  postgres image: pgvector/pgvector:pg16  id=$(docker image inspect -f '{{.Id}}' pgvector/pgvector:pg16)"
}

phase_frontend_bundle_check() {
  log "Verifying the built frontend bundle was baked for this enclave's URLs (SHIPMENT_PLAN.md Section 1.2)"
  # Checked here, right after load, rather than after the containers are up —
  # this doesn't need anything running, so a URL mismatch is caught before
  # the rest of the install runs, not after.
  local hits
  hits=$(docker run --rm --entrypoint sh "$(frontend_image)" -c \
    "grep -Fl '${VITE_API_URL}' /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l") || hits=0
  [ "$hits" -gt 0 ] || fail "built frontend bundle does not contain the expected VITE_API_URL (${VITE_API_URL}) — this image was built for a different origin and needs rebuilding for this enclave, not just reconfigured (Section 1.2's build-time URL baking)"
  pass "frontend bundle baked with the expected VITE_API_URL"
}

phase_postgres() {
  log "Phase C: bring up Postgres, verify pgvector"

  "${COMPOSE[@]}" up -d postgres
  log "Waiting for Postgres to report healthy..."
  timeout 60 bash -c '
    until [ "$(docker compose -f docker-compose.yml -f docker-compose.enclave.yml ps -q postgres | xargs docker inspect -f "{{.State.Health.Status}}")" = "healthy" ]; do
      sleep 2
    done
  ' || fail "postgres did not become healthy within 60s"
  pass "postgres healthy"

  local pgver
  pgver=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "SHOW server_version_num;") \
    || fail "could not query postgres server_version_num"
  [ "$pgver" -ge 160000 ] || fail "Postgres $pgver < 16.0 — pgvector HNSW indexing (database/migrations/0009) requires PG16+"
  pass "postgres version $pgver >= 160000"

  "${COMPOSE[@]}" exec -T postgres sh -c 'test -f "$(pg_config --sharedir)/extension/vector.control"' \
    || fail "vector.control not found under \$(pg_config --sharedir)/extension inside the postgres container — the loaded image is not pgvector/pgvector:pg16, re-stage the correct tar"
  pass "vector.control present"

  "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    || fail "CREATE EXTENSION vector failed"
  pass "pgvector extension available"
}

phase_migrate() {
  log "Phase D: apply migrations (non-destructive — never migrate:rollback here)"

  "${COMPOSE[@]}" --profile tools run --rm migrate \
    || fail "migration run failed"
  "${COMPOSE[@]}" --profile tools run --rm migrate npx knex --knexfile knexfile.js migrate:status
  pass "migrations applied"
}

phase_grants() {
  log "Phase E: verify app_runtime_user grants against the corrected per-table matrix (SHIPMENT_PLAN.md Section 2.7 — not a flat 'all except audit_logs' rule)"

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
          || fail "$table privileges are '$privs', expected full CRUD (DELETE,INSERT,SELECT,UPDATE) — if this is a new table added since SHIPMENT_PLAN.md Section 2.7 was written, update that table there too"
        ;;
    esac
  done <<< "$grants"
  pass "app_runtime_user grants match the expected per-table matrix"
}

phase_vllm_models() {
  log "Phase F: confirm the configured vLLM models are actually served, not just that the host answers"

  local models_json
  models_json=$(curl -sf --max-time 5 "${LLM_BASE_URL}/v1/models") \
    || fail "could not fetch ${LLM_BASE_URL}/v1/models"

  local have_model have_embed
  have_model=$(echo "$models_json" | docker run --rm -i "$(backend_image)" node -e "
    let d = ''; process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => {
      const j = JSON.parse(d);
      console.log(j.data.some((m) => m.id === '${LLM_MODEL}') ? 'yes' : 'no');
    });
  ")
  [ "$have_model" = "yes" ] || fail "generation model '${LLM_MODEL}' not found among vLLM-served models — confirm the GPU host has this model loaded"

  have_embed=$(echo "$models_json" | docker run --rm -i "$(backend_image)" node -e "
    let d = ''; process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => {
      const j = JSON.parse(d);
      console.log(j.data.some((m) => m.id === '${EMBEDDING_MODEL}') ? 'yes' : 'no');
    });
  ")
  [ "$have_embed" = "yes" ] || fail "embedding model '${EMBEDDING_MODEL}' not found among vLLM-served models — semantic search will 503 without it"
  pass "LLM_MODEL and EMBEDDING_MODEL both served by ${LLM_BASE_URL}"

  # curl's --max-time takes seconds; LLM_TIMEOUT_MS is milliseconds. The
  # earlier draft used `${LLM_TIMEOUT_MS:-30000}e-3`, which is not valid
  # curl syntax — this is the actual integer-seconds fix (round up).
  local timeout_s=$(( (${LLM_TIMEOUT_MS:-30000} + 999) / 1000 ))

  log "Direct provider round-trip: completion"
  curl -sf --max-time "$timeout_s" -X POST "${LLM_BASE_URL}/v1/completions" \
    -H "Authorization: Bearer ${LLM_API_KEY:-}" -H 'Content-Type: application/json' \
    -d "{\"model\":\"${LLM_MODEL}\",\"prompt\":\"ping\",\"max_tokens\":1}" >/dev/null \
    || fail "test completion against ${LLM_BASE_URL} failed — check LLM_API_KEY and vLLM gateway logs"
  pass "vLLM completion round-trip succeeded"

  log "Direct provider round-trip: embedding dimension check"
  local emb_len
  emb_len=$(curl -sf --max-time "$timeout_s" -X POST "${LLM_BASE_URL}/v1/embeddings" \
    -H "Authorization: Bearer ${LLM_API_KEY:-}" -H 'Content-Type: application/json' \
    -d "{\"model\":\"${EMBEDDING_MODEL}\",\"input\":\"test\"}" \
    | docker run --rm -i "$(backend_image)" node -e "
      let d = ''; process.stdin.on('data', (c) => { d += c; });
      process.stdin.on('end', () => {
        const j = JSON.parse(d);
        console.log(j.data[0].embedding.length);
      });
    ") || fail "embedding round-trip failed"
  [ "$emb_len" = "${EMBEDDING_DIMENSION}" ] \
    || fail "embedding returned length $emb_len, expected EMBEDDING_DIMENSION=${EMBEDDING_DIMENSION} — message_embeddings.embedding is a fixed vector(N) column, this mismatch will break on the first real semantic search rather than failing here"
  pass "embedding dimension matches EMBEDDING_DIMENSION ($emb_len)"
}

phase_bring_up_app() {
  log "Phase G: bring up backend/frontend"

  "${COMPOSE[@]}" up -d backend frontend

  timeout 60 bash -c '
    until curl -sf http://localhost:8101/health/live >/dev/null; do sleep 2; done
  ' || fail "backend /health/live did not become reachable within 60s"
  pass "backend liveness reachable"

  timeout 90 bash -c '
    until curl -sf http://localhost:8101/health >/dev/null; do sleep 2; done
  ' || fail "backend /health did not become reachable within 90s"

  "${COMPOSE[@]}" exec -T backend node -e "
    (async () => {
      const d = await (await fetch('http://localhost:8000/health')).json();
      if (!d.ai || d.ai.healthy !== true) {
        console.error(JSON.stringify(d));
        process.exit(1);
      }
      console.log('vLLM provider healthy:', JSON.stringify(d.ai));
    })();
  " || fail "backend is up but reports the vLLM provider unhealthy — check LLM_BASE_URL/LLM_API_KEY/ALLOWED_LLM_ORIGINS and the GPU host's own logs"
  pass "backend reports DB + vLLM provider healthy"

  "${COMPOSE[@]}" exec -T frontend sh -c "test -f /usr/share/nginx/html/index.html" \
    || fail "frontend static build missing"
  pass "frontend static build present"
}

phase_validate_config() {
  log "Validating CORS_ORIGIN / ALLOWED_LLM_ORIGINS against the actual configuration"

  local expected_origin="${VITE_API_URL%/api}"
  case ",${CORS_ORIGIN}," in
    *",${expected_origin},"*)
      pass "CORS_ORIGIN includes the expected browser origin ($expected_origin)"
      ;;
    *)
      fail "CORS_ORIGIN ('${CORS_ORIGIN}') does not include the expected browser origin ($expected_origin, derived from VITE_API_URL) — the frontend will load but every API call will be blocked as cross-origin"
      ;;
  esac

  local llm_origin
  llm_origin=$(echo "$LLM_BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
  if [ -z "${ALLOWED_LLM_ORIGINS:-}" ]; then
    pass "ALLOWED_LLM_ORIGINS unset — config.js falls back to LLM_BASE_URL's own origin ($llm_origin), which is safe"
  else
    case ",${ALLOWED_LLM_ORIGINS}," in
      *",${llm_origin},"*)
        pass "ALLOWED_LLM_ORIGINS includes LLM_BASE_URL's own origin ($llm_origin)"
        ;;
      *)
        fail "ALLOWED_LLM_ORIGINS ('${ALLOWED_LLM_ORIGINS}') does not include LLM_BASE_URL's own origin ($llm_origin) — an admin could never re-confirm this exact baseUrl via PATCH /api/ai/settings without first widening this list"
        ;;
    esac
  fi
}

phase_first_admin() {
  if [ "${SKIP_FIRST_ADMIN:-0}" = "1" ]; then
    log "SKIP_FIRST_ADMIN=1 — skipping first-admin creation and the end-to-end smoke test that depends on it"
    return
  fi

  log "No accounts can exist yet on a fresh install — create the first system admin now"
  local username email password
  read -rp "First system-admin username: " username
  read -rp "First system-admin email: " email
  read -rsp "First system-admin password: " password
  echo

  "${COMPOSE[@]}" exec -T backend node /app/scripts/create-first-admin.mjs "$username" "$email" "$password" \
    || fail "create-first-admin.mjs failed"
  pass "first system admin created ($username)"

  FIRST_ADMIN_USERNAME="$username"
  FIRST_ADMIN_PASSWORD="$password"
}

phase_smoke_test() {
  if [ -z "$FIRST_ADMIN_USERNAME" ]; then
    log "Skipping end-to-end smoke test (no first-admin credentials available — SKIP_FIRST_ADMIN=1)"
    return
  fi

  log "End-to-end smoke test: login, workspace, channel, message, AI summarize"
  log "(Leaves an 'Enclave Install Verification' workspace behind on purpose — delete it manually if you don't want it, same as the punch list's own acceptance checklist does.)"

  local login_resp token ws_id ch_id summary_bytes

  login_resp=$(curl -sf -X POST http://localhost:8101/api/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${FIRST_ADMIN_USERNAME}\",\"password\":\"${FIRST_ADMIN_PASSWORD}\"}") \
    || fail "smoke-test login failed"
  token=$(echo "$login_resp" | json_field accessToken)
  if [ -z "$token" ] || [ "$token" = "undefined" ]; then fail "smoke-test login did not return an accessToken"; fi
  pass "smoke-test login succeeded"

  ws_id=$(curl -sf -X POST http://localhost:8101/api/workspaces \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"name":"Enclave Install Verification"}' | json_field id) \
    || fail "smoke-test workspace creation failed"
  if [ -z "$ws_id" ] || [ "$ws_id" = "undefined" ]; then fail "smoke-test workspace creation did not return an id"; fi

  ch_id=$(curl -sf -X POST "http://localhost:8101/api/workspaces/${ws_id}/channels" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"name":"general","type":"PUBLIC"}' | json_field id) \
    || fail "smoke-test channel creation failed"
  if [ -z "$ch_id" ] || [ "$ch_id" = "undefined" ]; then fail "smoke-test channel creation did not return an id"; fi
  pass "smoke-test workspace/channel created"

  curl -sf -X POST "http://localhost:8101/api/channels/${ch_id}/messages" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"content":"enclave install smoke test"}' >/dev/null \
    || fail "smoke-test message send failed"
  pass "smoke-test message sent"

  summary_bytes=$(curl -sfN -X POST "http://localhost:8101/api/channels/${ch_id}/ai/summarize" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}' | wc -c) \
    || fail "AI summarize request failed"
  [ "$summary_bytes" -gt 0 ] \
    || fail "AI summarize returned an empty response — this is the first real proof of the backend-to-vLLM path through the actual app (not just the direct provider round-trip in Phase F); check backend logs"
  pass "AI summarize returned a non-empty streamed response ($summary_bytes bytes) through the real app"

  log "Not run here (time-dependent, belongs to the separate post-install acceptance checklist — SHIPMENT_PLAN.md Section 5 / the original punch list's verification steps 6-7): semantic search (needs to wait out EMBEDDING_WORKER_INTERVAL_MS) and the audit-dashboard API path."
}

phase_audit_verify() {
  log "Verifying audit log hash chain"
  "${COMPOSE[@]}" exec -T backend node /app/scripts/verify-audit-log.mjs \
    || fail "audit log verification failed"
  pass "audit log integrity verified"
}

phase_write_report() {
  {
    echo ""
    echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo ""
    echo "Resolved environment (secrets redacted):"
    env | grep -E '^(LLM_|EMBEDDING_|POSTGRES_|APP_DB_|CORS_ORIGIN|VITE_|TASK_|AI_)' \
      | sed -E 's/^(.*_(PASSWORD|SECRET|API_KEY)=).*/\1REDACTED/' \
      | sort
  } >> "$REPORT_FILE"
  log "Install report written: $REPORT_FILE"
}

main() {
  report "Silent Whisper enclave install report"
  report "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report "Git commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  report "Git describe: $(git describe --tags --always 2>/dev/null || echo unknown)"
  report ""

  phase_preflight
  phase_load_images
  phase_frontend_bundle_check
  phase_postgres
  phase_migrate
  phase_grants
  phase_vllm_models
  phase_bring_up_app
  phase_validate_config
  phase_first_admin
  phase_smoke_test
  phase_audit_verify
  phase_write_report

  log ""
  log "Enclave install complete. See ${REPORT_FILE} for the full report."
  log "This script does not configure a reverse proxy or TLS in front of the"
  log "stack (SHIPMENT_PLAN.md Section 1.4) — that decision and its artifact"
  log "belong to whoever owns this enclave's network topology."
}

main "$@"

# --- What this script deliberately does NOT do ---
# - Does not generate secrets (JWT_SECRET/POSTGRES_PASSWORD/APP_DB_PASSWORD)
#   — RUNBOOK.md's documented `node -e "crypto.randomBytes(...)"` one-liners
#   are the way; an installer silently generating and storing secrets
#   somewhere is a bigger risk than asking the operator to do it once.
# - Does not touch any reverse proxy or certificate — see Section 1.4.
# - Does not run `docker compose down -v`, `migrate:rollback`, or any other
#   destructive operation under any flag or condition. A broken install
#   should be diagnosed and re-run, never nuked by this script.
# - Does not build any image — every `docker compose` call above uses
#   docker-compose.enclave.yml's `image:` entries, never `--build`.
