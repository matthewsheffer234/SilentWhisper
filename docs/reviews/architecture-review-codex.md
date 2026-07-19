# Architecture Review (Codex)

## 1. Summary & Verdict

Silent Whisper is architecturally coherent for the stated near-term target of 100 total users and roughly 30 simultaneous users. The implementation follows many of the plan's important constraints: a single backend instance with in-memory WebSocket/presence state, bounded PostgreSQL pooling, server-side membership checks, cursor-paginated message history, httpOnly refresh cookies, in-memory access tokens, hash-chained audit logs with a PostgreSQL advisory lock, local-only LLM adapters, and explicit rate/concurrency limits for expensive AI paths.

The architecture is not yet high-availability in the operational sense. The backend, frontend, PostgreSQL, Ollama, shared nginx entrypoint, and host are all single points of failure. That is acceptable for the current local/intranet deployment only if "high availability" means fast restart and operational recoverability rather than no-downtime service continuity.

The main scaling concern is that several user-facing paths still combine synchronous request handling with extra side effects. Message send does the database insert, WebSocket broadcast, entity linking, mention resolution, notification creation, and embedding-job enqueue inline. AI and embedding work are correctly capped, but with CPU-only Ollama and default concurrency of 1, AI/search capacity will become the first visible bottleneck under real usage. At 5x-10x the current design target, the application needs a deliberate next scaling milestone: shared real-time state, worker separation, query/index hardening, static frontend serving, restart policies, and provider allowlisting.

Verdict: healthy for the documented single-node target, but only "medium maturity" as a production architecture. It has good security foundations and thoughtful code organization, but high availability and 5x-10x scale require structural changes rather than tuning alone.

## 2. Identified Risks & Bottlenecks

### Risk 1: Single-host / single-process availability ceiling

- Component: Docker Compose deployment, backend process, frontend Vite server, PostgreSQL, Ollama, shared `wireservice-nginx-1`.
- Evidence: `docker-compose.yml` runs one backend, one PostgreSQL, one frontend, one Ollama instance; `connectionRegistry.js` and `presence.js` intentionally keep WebSocket room and presence state in memory; README notes the public URL still serves Vite's dev server and certbot renewal hooks are not functional.
- Failure mode: any backend crash disconnects all users and drops presence/room state; host or nginx failure takes the whole app down; PostgreSQL failure takes all API paths down; expired TLS renewal eventually causes external outage; Vite dev server is not an efficient or hardened production frontend.
- Distance-to-failure: Near for high-availability expectations; Medium for 30 simultaneous users; Near at 5x-10x if load or operational churn increases.

### Risk 2: AI and semantic search are capacity-limited by one local provider

- Component: `backend/src/llm/aiService.js`, `backend/src/search/embeddingService.js`, Ollama container, pgvector semantic search.
- Evidence: `LLM_MAX_CONCURRENT_REQUESTS` defaults to 1; `EMBEDDING_MAX_CONCURRENT_REQUESTS` defaults to 1; AI generation and embeddings share the configured provider; README notes `vllm` is implemented but not exercised against a real vLLM instance.
- Failure mode: one long summarization, digest, or embedding call can make AI/search appear unavailable to other users; embedding backlog can lag under message bursts; CPU-only Ollama is a near-term latency bottleneck; admin-editable `baseUrl` also creates an SSRF/DoS risk if an admin account is compromised.
- Distance-to-failure: Near for AI-heavy use even at current scale; Medium for normal chat-only usage; Near at 5x-10x.

### Risk 3: Message send path has too many inline side effects

- Component: REST send route `backend/src/routes/messages.js`, WebSocket send handler `backend/src/ws/server.js`, mention/entity/notification/embedding services.
- Evidence: after creating a message, both transports synchronously broadcast, link entities, extract mentions, write notifications, send targeted notifications, and enqueue embedding work. Some failures are swallowed, but the route still waits for multiple side effects.
- Failure mode: message latency grows with mention count, entity parsing, notification fan-out, database queueing, and embedding enqueue latency. Under bursts, p95 send latency will degrade before raw WebSocket broadcast becomes the bottleneck.
- Distance-to-failure: Medium at current target; Near at 5x if channels become busy or messages commonly include mentions/entities.

### Risk 4: Security backlog still contains live medium-risk items

- Component: auth middleware, WebSocket authentication, AI settings, invitations, WebSocket frame handling, group-DM membership.
- Evidence: README and `Security.md` list remaining issues: disabled accounts keep existing access tokens/WebSockets until token expiry; LLM `baseUrl` accepts any admin-supplied HTTP(S) origin; archived workspace/org invitations can still be redeemed; no explicit WebSocket payload cap; no group-DM member cap.
- Failure mode: disabled users retain a short access window; a compromised system admin can make backend-originated requests to internal services or break AI globally; oversized WebSocket frames can consume memory/CPU; large group DMs can become inefficient mini-broadcast channels.
- Distance-to-failure: Near for security hardening; Medium for performance impact; Far for catastrophic compromise if system-admin access is well protected.

### Risk 5: Some query paths are bounded but not yet 10x-ready

- Component: semantic search, workspace digest selection, audit verification, admin list views.
- Evidence: message history is paginated and indexed, but semantic search orders by vector distance across authorized joins; workspace digest can read up to 10 channels and 400 selected messages; audit verification reads the whole `audit_logs` table; admin "all" views are not paginated.
- Failure mode: at larger data volumes, vector search can spend work ranking many embeddings before authorization filters are selective enough; audit verification becomes an expensive whole-table operation; admin pages can produce large responses as organizations/workspaces/users grow.
- Distance-to-failure: Far for 100 total users; Medium at 5x-10x or after long message retention.

## 3. Actionable Recommendations

### P0: Close known security gaps before broader rollout

1. Enforce active-user status in `requireAuth` and WebSocket `handleAuthenticate`, not only at login.
2. On admin disable, close all live WebSocket connections for that user via the in-memory connection registry.
3. Add `maxPayload` to the WebSocket server and reject oversized frames before JSON parsing.
4. Add a hard group-DM member cap and enforce it at creation/update time.
5. Restrict LLM provider `baseUrl` to an explicit deployment allowlist such as `ALLOWED_LLM_ORIGINS`, or make provider endpoint changes environment-only.
6. Block redemption of invitations tied to archived organizations/workspaces.

### P1: Improve operational availability on the current single host

1. Add Compose `restart: unless-stopped` or equivalent restart policy for backend, frontend, PostgreSQL, and Ollama.
2. Replace the public Vite dev server with a production static build served by nginx or a minimal static server.
3. Fix certbot renewal hooks for all hosted domains and document renewal verification in `RUNBOOK.md`.
4. Add `/health` depth options: lightweight liveness, DB readiness, and optional AI/provider readiness. Do not make provider health a hard dependency for the whole app unless AI is critical.
5. Add basic backup/restore runbooks for PostgreSQL and Ollama model volume state.

### P2: Move non-critical message side effects off the hot path

1. Keep message insert and room broadcast synchronous.
2. Move mention extraction, notification writes, entity linking, and embedding enqueue into a durable `message_side_effect_jobs` table or separate typed queue tables.
3. Process the queue in the existing worker pattern using `FOR UPDATE SKIP LOCKED`.
4. Make the UI tolerate delayed mention notifications and delayed search indexing.
5. Track queue depth, oldest job age, failed job count, and processing latency.

### P3: Prepare for the 5x-10x scaling milestone

1. Do not add PM2 clustering or multiple backend replicas until WebSocket fan-out, presence, rate limits, and per-user connection counts move to shared infrastructure.
2. If concurrent usage exceeds the single-instance target, introduce Redis for pub/sub, presence, connection metadata, and distributed rate limiting.
3. Add sticky-session routing or a WebSocket-aware load-balancer policy if multiple backend instances are introduced.
4. Re-tune PostgreSQL pool size after measuring query wait time; do not blindly scale pool size with users.
5. Split AI generation and embedding onto separate provider endpoints or separate concurrency budgets backed by provider-level capacity.

### P4: Harden large-data query paths

1. Paginate all admin list endpoints.
2. Convert audit verification into an offline/admin maintenance job for large tables, or maintain periodic verification checkpoints.
3. Add query plans to the load-test report for semantic search, workspace digest, member search, and audit views.
4. For semantic search, evaluate a two-stage approach: pre-filter authorized message IDs/channel IDs, then vector-rank a bounded candidate set, or maintain per-workspace/per-channel search partitions if data grows.
5. Add retention/archive policies for audit logs, messages, notifications, failed embedding jobs, and old refresh tokens.

## 4. Refactoring Plan

### Phase 1: Security and deployment hardening

1. Update REST and WebSocket authentication to reject disabled users on every identity establishment.
2. Add a connection-registry helper to close all sockets for a user when an admin disables that account.
3. Configure WebSocket `maxPayload` and add tests for oversized frames.
4. Add LLM origin allowlisting and tests for rejected loopback/unapproved origins.
5. Add invitation redemption checks for archived org/workspace targets.
6. Add Compose restart policies and replace the frontend dev server with a production static build.

### Phase 2: Message side-effect queue

1. Add a migration for a durable side-effect job table keyed by `message_id` and job type.
2. Change `createMessage` callers to insert the message and enqueue side-effect jobs in one transaction.
3. Keep WebSocket/REST response timing tied only to message persistence and broadcast.
4. Implement worker processors for mentions, notifications, entity links, and embedding enqueue.
5. Add tests for retry, dead-letter behavior, idempotency, and duplicate job insertion.

### Phase 3: Observability and capacity baselines

1. Extend `scripts/load-test.mjs` to report p95/p99 for message send, broadcast receipt, message history, semantic search, digest selection, and AI rejection/capacity behavior.
2. Add backend metrics logs or a lightweight metrics endpoint for DB pool usage, WebSocket connection count, queue depth, AI in-flight count, embedding in-flight count, and provider health.
3. Capture `EXPLAIN ANALYZE` plans for the highest-risk queries after synthetic data generation.
4. Record baseline numbers for 30, 100, 150, and 300 simultaneous users so the next scaling decision is data-driven.

### Phase 4: Multi-instance readiness, only when needed

1. Introduce Redis or an equivalent shared state layer for presence, room membership metadata, distributed rate limits, and pub/sub fan-out.
2. Wrap `connectionRegistry` behind an interface so local in-memory and Redis-backed implementations can coexist during migration.
3. Add load-balancer configuration for WebSocket upgrades and sticky routing where required.
4. Move background workers into separately scalable processes.
5. Revisit PostgreSQL deployment topology, backups, and failover if the business goal shifts from local/intranet availability to true production HA.

