# Silent Whisper — Architectural Review

**Reviewer perspective**: independent architecture review, evaluated against the stated design envelope (100 total users / 30 simultaneous) and a 5x–10x growth scenario (150–300 simultaneous users).
**Sources**: `PROJECT_PLAN.md`, `RUNBOOK.md`, `Security.md`, `FEATURE_REQUEST.md`, `docker-compose.yml`, and direct inspection of `backend/src` and `frontend/src`.

---

## 1. Summary & Verdict

Silent Whisper is a well-scoped, deliberately single-instance messaging platform, and for its stated target — **100 total users, 30 simultaneous** — the architecture is sound: a lean dependency footprint (11 backend runtime deps, 5 frontend), parameterized queries throughout, a genuinely tamper-evident audit log, a clean provider-adapter boundary for the LLM integration, and a real, DB-backed job queue (`embedding_jobs`, with correct `FOR UPDATE SKIP LOCKED` semantics) for the one background-processing workload that has one. Test coverage is substantial (431 backend tests, 65 frontend, a real Playwright e2e suite) and the project's own implementation log shows a consistent discipline of finding and fixing real bugs via e2e verification rather than by inspection alone.

The core finding of this review is that **the architecture's scaling ceiling is explicit, not accidental** — `PROJECT_PLAN.md` Section 2 states outright that presence, rate limiting, and WebSocket fan-out live in backend process memory *because* the deployment target is a single Node.js instance, and that this must not be relaxed without introducing shared state. That is a legitimate, honestly-documented design decision at 30 simultaneous users. It stops being legitimate somewhere between 3x and 10x current load, and several of the systems built on top of it (AI inference concurrency, in particular) are already at their ceiling *today*, not just at 10x.

**Verdict**: Healthy for current scale. Not scale-ready for 5x–10x without targeted changes — none of which require a rewrite, but several of which require decisions made *before* traffic forces them (state externalization, a production frontend build, and decoupling the audit-write path from the request-response cycle). The more immediate risk to the stated business goals is not scale at all — it's the fully manual build/deploy/reload process and the absence of CI, which is the direct cause of several regressions already recorded in `PROJECT_PLAN.md`'s own implementation log ("stale frontend container" recurring across at least four separate feature entries).

---

## 2. Identified Risks & Bottlenecks

### Risk 1 — AI/LLM inference has a hard concurrency ceiling of 1, with no queue
**Component**: `backend/src/llm/concurrencyGate.js`, the dedicated `silent-whisper-ollama` container (`docker-compose.yml`), `LLM_MAX_CONCURRENT_REQUESTS` (default `1`).
**Failure mode**: `tryAcquire()` is non-blocking by design — a second concurrent AI request (Summarize, Extract Tasks, Catch Me Up digest) while one is in flight gets an immediate `503`, not a queued response. This is one global counter shared across *all* users of the deployment, not per-user. At today's scale, two people clicking "Summarize" within the same ~10–20s window already produces a rejection for one of them.
**Distance-to-failure**: **Near.** This isn't a future risk — it's a present, known, and currently-accepted trade-off for a CPU-only, single-Ollama-instance test environment (per `PROJECT_PLAN.md` Section 2's own reasoning). At 5x–10x simultaneous users, if AI feature adoption scales proportionally, "occasionally busy" becomes "usually busy," and the feature becomes effectively unusable during normal working hours rather than degraded at the margins. `LLM_PROVIDER=vllm` exists as an escape hatch but is unit-tested only, never run against a real GPU-backed instance (per `README.md`'s Known Issues).

### Risk 2 — In-memory, single-instance runtime state blocks horizontal scaling
**Component**: `backend/src/ws/connectionRegistry.js` (user↔socket, channel↔room maps), `backend/src/ws/presence.js`, `backend/src/auth/rateLimit.js` / `backend/src/llm/aiRateLimit.js` (in-process token buckets via `express-rate-limit`), and the LLM concurrency gate above — all explicitly single-process state, by design (`PROJECT_PLAN.md` Section 2: "Do not introduce a multi-instance requirement... without also introducing a shared state store").
**Failure mode**: None of these correctness guarantees survive a second backend replica. A second instance behind a load balancer would silently fragment presence (users appear offline to half the room), rate limits (each instance enforces its own independent quota, doubling the effective limit), and WebSocket fan-out (a message broadcast on instance A never reaches a client connected to instance B). This is a *correctness* failure, not just a performance one, if anyone ever scales out without first addressing it.
**Distance-to-failure**: **Medium.** At 30–100 concurrent users a single Node.js process is genuinely fine — event-loop-bound work here (JSON handling, WS fan-out, rate-limit bookkeeping) is cheap, and the one CPU-heavy operation (bcrypt) already runs off-thread via libuv. Somewhere in the 150–300 concurrent range, a single core becomes the practical ceiling for message-broadcast fan-out latency, and the natural first response — "add a second backend replica" — is exactly the move this architecture cannot currently support without a rewrite of four subsystems.

### Risk 3 — Production frontend is served by Vite's dev server, not a built static bundle
**Component**: `frontend/Dockerfile` (`CMD ["npm", "run", "dev"]`), confirmed still true as of the current `README.md` Known Issues ("No production static frontend build exists yet — the public URL still serves Vite's dev server").
**Failure mode**: A dev server is optimized for iteration speed, not request throughput — no minification-driven caching story beyond what Vite's dev transform provides per-request, no long-lived immutable-asset caching headers, and it carries HMR/WebSocket overhead for every connected client whether or not anyone is actively developing. It is also a strictly larger, less audited attack surface than a static file server (arbitrary module resolution, `@vite/client`, `@react-refresh` endpoints all reachable in "production").
**Distance-to-failure**: **Near–Medium.** Functionally fine at 30 concurrent browser tabs on capable hardware; a real performance and operational-hygiene liability well before 10x, and arguably shouldn't be running in front of a public hostname (`whisper.silentlattice.dev`) regardless of current load.

### Risk 4 — The audit log's serialized write path sits on the synchronous hot path of nearly every mutating request
**Component**: `appendAuditEvent` (`backend/src/audit/auditService.js`), using `pg_advisory_xact_lock` to serialize the read-latest-hash-then-insert step (by design — this is what makes the hash chain tamper-evident, and it's correct even across multiple backend instances, unlike Risk 2's state).
**Failure mode**: Every audited action — login, failed login, every AI call, every membership/role change, every admin action — blocks on one global advisory lock before the request can complete, because `appendAuditEvent` is awaited inline in the request handler rather than decoupled from it. This is deliberate and correct for integrity, but it means audit-write latency is *directly* on the critical path of user-facing actions, and it is a single serialization point regardless of how many backend instances exist.
**Distance-to-failure**: **Medium.** Advisory-lock contention is cheap at low write volume; it becomes a measurable tail-latency contributor as concurrent mutating actions scale, and — unlike Risk 2 — it does not go away by adding backend instances, because the lock is at the database level. No load test to date has isolated this path specifically (`scripts/load-test.mjs` exercises the general REST/WS surface, per `RUNBOOK.md`).

### Risk 5 — No CI/CD and a fully manual deploy process, already a proven source of regressions
**Component**: repo-wide — no `.github/workflows` (or equivalent) exists; deployment is `docker compose up -d --build backend frontend` run by hand, followed by a manual `docker exec wireservice-nginx-1 nginx -s reload` when the public domain is affected (both performed manually in this very session).
**Failure mode**: Nothing gates a broken build or a regressed test from reaching `main`, and nothing gates `main` from being deployed with a stale container image. `PROJECT_PLAN.md` Section 11 documents this exact failure mode recurring at least four separate times across recent feature entries ("the running backend/frontend containers had no source volume mount and were still serving pre-change images") — each one a real, user-visible bug caught only because e2e tests happened to be run immediately afterward.
**Distance-to-failure**: **Near.** This is not a future risk under load — it is an already-materialized, repeatedly-recurring operational defect today, and it directly undermines the stated "rapid feature iteration" goal by making every deploy a manual, error-prone, unverified step.

---

## 3. Actionable Recommendations

Ordered by leverage (impact relative to effort), not strictly by the risk numbering above.

**P0 — do before the next few feature releases, independent of traffic growth:**
1. **Add a minimal CI workflow** (GitHub Actions or equivalent) that runs `npm test` (backend), `npm run test:unit` (frontend), and `npm run build` (frontend) on every PR into `main`. This is the single cheapest fix on this list and directly addresses Risk 5's recurring, already-proven failure mode. It does not require solving deployment automation to deliver most of the value — a red CI check that would have caught "forgot to rebuild the container" is not itself possible to catch in CI (that's a deploy-time issue), but a red CI check *would* catch the underlying source-of-truth mismatches faster than the current "find it during manual e2e" pattern.
2. **Build a real production frontend bundle.** Add a build stage to `frontend/Dockerfile` (`npm run build` → serve `dist/` via a lightweight static server, e.g. `nginx:alpine` or `serve`) and switch `docker-compose.yml`'s `frontend` service to it. This removes Risk 3 entirely, and is low-risk because the app already builds cleanly (`npx vite build` is already part of this project's own verification routine per the implementation log).
3. **Script the deploy step.** Even a simple `scripts/deploy.sh` wrapping `docker compose up -d --build backend frontend && docker exec wireservice-nginx-1 nginx -s reload` (with the reload conditional on whether the public domain is actually affected) removes the human-memory dependency that has caused the recurring bug class in Risk 5.

**P1 — do before committing to 5x–10x scale, not urgent today:**
4. **Introduce a shared state store (Redis) before adding a second backend instance.** This is the prerequisite for resolving Risk 2, not a general-purpose "nice to have" — do not add a second replica without it. Scope narrowly: presence (`ws/presence.js`), the WS connection registry / room fan-out (`ws/connectionRegistry.js`), and the two rate limiters can each move to Redis-backed implementations independently and incrementally; `express-rate-limit` already has an official Redis store adapter, minimizing the rewrite surface for that piece specifically.
5. **Decouple the audit write from the request path (Risk 4).** The project already has a proven pattern for exactly this shape of problem: `embedding_jobs` + `embeddingWorker.js`'s `FOR UPDATE SKIP LOCKED` polling worker. Apply the same outbox pattern to audit writes — insert a lightweight, unhashed "pending audit event" row synchronously (cheap, no lock contention) and have a single background worker apply the hash-chain computation and advisory-lock-serialized insert asynchronously. This preserves the tamper-evidence guarantee while removing lock contention from the user-facing request path. Requires care: the dashboard's "freshest N events" view would need to account for pending-but-not-yet-chained rows, and any *authorization-critical* synchronous read of the chain (there currently is none) would need to wait for the write to land.
6. **Give the AI concurrency gate a bounded queue instead of hard-rejecting (Risk 1).** A small in-memory FIFO queue (bounded, e.g. depth 5–10, with a client-visible "queued, position N" state rather than a silent wait) would meaningfully improve perceived reliability at 2x–3x AI usage without needing a second Ollama instance or GPU migration. This is a stopgap, not a scale fix — the real fix for Risk 1 at 10x is the already-designed `vLLM` migration path, which needs to actually be exercised against a real GPU host before being trusted (per the open Known Issue).

**P2 — maintainability, address opportunistically alongside nearby feature work:**
7. **Decompose `ChatShell.jsx` (887 lines) and `backend/src/routes/workspaces.js` (1,241 lines).** Both have grown into god-components/god-routers holding many unrelated concerns (see Refactoring Plan below). Not urgent, but each new feature landing in either file increases regression risk — several of the "found by e2e, not by inspection" bugs logged in `PROJECT_PLAN.md` Section 11 trace back to `ChatShell.jsx`'s sprawling cross-cutting state (e.g., the stale-selected-workspace-after-org-switch bug).
8. **Close the remaining Medium/Low `Security.md` findings** already tracked as `FEATURE_REQUEST.md` entry 1 (Proposed): disabled-account tokens/WebSocket sessions remaining valid until natural expiry, the LLM `baseUrl` accepting any admin-supplied origin (SSRF/DoS surface), archived-workspace/org invitation redemption, no WebSocket payload cap, no group-DM member cap. None are High severity (the two that were have already been fixed), but all are cheap relative to their risk and already fully designed in that document — this is execution, not further design work.

**Explicitly not recommended right now:** introducing a message broker, splitting into microservices, or moving off Postgres/Knex. None of the identified risks are solved by that class of change, the current dependency footprint is a genuine strength (fast to reason about, fast to test, fast to onboard into), and none of it is justified at the stated 100-user target or even comfortably past it.

---

## 4. Refactoring Plan

Two structural changes are large enough to warrant a step-by-step plan rather than a single PR: **(A)** externalizing single-instance runtime state, and **(B)** decomposing the two oversized files. Both are incremental and shippable in independent slices — neither requires a big-bang rewrite or downtime.

### A. Externalize single-instance runtime state (unlocks horizontal scaling — addresses Risk 2)

1. **Stand up Redis as a new Compose service**, sized minimally (this workload is small key-value/pub-sub traffic, not a cache-heavy dataset) — mirror the existing `mem_limit` discipline already applied to every other service in `docker-compose.yml`.
2. **Migrate rate limiting first** — lowest risk, and an off-the-shelf path exists (`express-rate-limit`'s Redis store). Ship behind the existing limiter interfaces (`loginIpLimiter`, `aiProxyRateLimiter`, etc.) so call sites in `routes/*.js` don't change at all.
3. **Migrate presence next.** Replace `ws/presence.js`'s in-memory heartbeat map with Redis keys carrying a TTL (natural fit for "online until heartbeat stops arriving" semantics), published via Redis pub/sub so every backend instance's WS layer observes the same presence state.
4. **Migrate the WS connection registry / room fan-out last** — the highest-risk piece, since it's the one with an actual open connection object (`ws`) that can't itself live in Redis. The standard pattern: keep the local `userId -> Set<ws>` map for *this instance's own* connections (unavoidable — the socket object is process-local), but move room membership and cross-instance broadcast to Redis pub/sub, so a message published on instance A gets fanned out to instance B's locally-connected sockets too. This is the piece that actually makes a second backend replica safe to add.
5. **Load-test with two backend instances behind a shared point of entry** before ever running two in production — the existing `scripts/load-test.mjs` is a reasonable starting point but currently assumes a single backend URL.
6. Each step ships independently; do not attempt all four in one PR.

### B. Decompose the two oversized files (addresses Risk in Recommendation 7)

**`backend/src/routes/workspaces.js` (1,241 lines)** currently mixes workspace CRUD, channel CRUD, channel-membership management, invitations, ownership transfer, visibility/settings, and admin oversight in one router file.
1. Extract channel CRUD + channel-membership endpoints into `routes/channels.js`, mounted the same way `routes/directMessages.js` and `routes/entities.js` already are (this file already establishes the "one router file per resource" convention elsewhere — `workspaces.js` is the outlier, not the pattern).
2. Extract ownership-transfer/visibility/settings endpoints into `routes/workspaceSettings.js`.
3. Leave the shared authorization module (`authz/membershipService.js`) untouched — it's already correctly factored out and is not part of this problem.
4. Each extraction is a pure move (no behavior change), verifiable by running the existing route-specific test files unchanged.

**`frontend/src/components/ChatShell.jsx` (887 lines)** currently owns the vast majority of top-level UI state (dozens of `useState` calls) and directly orchestrates roughly twenty child panels/sheets.
1. Extract panel-open/close state into a small number of purpose-grouped custom hooks (e.g. `useAdminPanels()`, `useWorkspaceSheets()`) rather than one flat state block — this is a mechanical extraction, not a behavior change, and is the same shape of refactor the codebase already applies elsewhere (e.g. `aiPresentation.js` as a pure, tested module extracted out of component code).
2. Extract the WebSocket message-handling `switch`/dispatch logic into a `useChatSocket()` hook, separating "how the socket is wired up and dispatched" from "what the shell renders."
3. Do this incrementally, one extraction per PR, each backed by the existing e2e suite (`frontend/e2e/workflows.spec.js` already exercises nearly every surface `ChatShell.jsx` touches, so regressions would be caught by the existing suite, not new tests).

---

## Appendix: What's working well (not risks, but worth preserving)

- **The provider-adapter interface for the LLM integration** (`llm/adapterFactory.js` + `adapters/`) is exactly the right shape for the stated Ollama-now/vLLM-later requirement — no branching on provider outside the factory.
- **The `embedding_jobs` durable queue** is genuinely multi-instance-safe today (`FOR UPDATE SKIP LOCKED`), unlike the in-memory state flagged in Risk 2 — it's the template to follow for Recommendation 5's audit-write decoupling.
- **The dependency footprint is deliberately lean** (11 backend runtime packages, 5 frontend) — this is a real cost-and-maintainability strength, not an oversight, and should be defended against scope creep as new features are added.
- **Authorization is centralized** in one shared module used by both REST and WebSocket handlers, exactly as `PROJECT_PLAN.md` Section 3 requires — this is why the two recent High-severity findings were each a one-file fix rather than a scattered one.
