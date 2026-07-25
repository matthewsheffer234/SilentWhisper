# Code Review Prompt Suite — Silent Whisper

This document contains a complete set of tailored review prompts for conducting comprehensive static code analysis, architectural audits, and quality assessments of the Silent Whisper repository using AI tools (such as OpenAI Codex or Anthropic Claude).

All reports generated from these prompts are configured to output directly into the `docs/reviews/` directory, formatted consistently, dated, and tagged with the specific application version under review.

Each prompt is self-contained by design — every one restates its own version/date-detection instructions and output format, since each is meant to be pasted into a fresh AI session with no memory of this document or any other prompt in the suite.

## Recommended Order of Execution

1. Security Baseline & Vulnerability Review (`docs/reviews/YYYY-MM-DD-security-review.md`)
2. Application Performance & Scalability Review (`docs/reviews/YYYY-MM-DD-performance-review.md`)
3. Code Efficiency & Resource Economy Review (`docs/reviews/YYYY-MM-DD-code-efficiency-review.md`)
4. Air-Gapped Enclave Readiness Review (`docs/reviews/YYYY-MM-DD-enclave-readiness-review.md`)
5. Enterprise Data Governance & Audit Compliance Review (`docs/reviews/YYYY-MM-DD-governance-audit-review.md`)
6. Maintainability & Code Quality Review (`docs/reviews/YYYY-MM-DD-maintainability-review.md`)
7. Accessibility & HIG Compliance Review (`docs/reviews/YYYY-MM-DD-accessibility-review.md`)

## Standardized Review Output Structure

Every prompt in this suite enforces the following unified output template:

````markdown
# [Review Type Title] — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation and overall risk/health score for this domain]

---

## Findings Matrix

| Severity | Domain | Finding / Risk | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [PREFIX-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Impact & Risk Scenario**: [Detailed breakdown of the issue, impact, or failure scenario]
- **Recommended Remediation**:
  ```[language]
  // Exact, copy-pasteable code fix or structural refactoring
  ```

## Architectural Wins & Compliant Patterns
[Highlight verified exemplary implementations matching design standards]
````

---

## Prompts

### 1. Security Baseline & Vulnerability Review

````text
You are an expert Application Security Engineer conducting a static code analysis and security review of the Silent Whisper repository. Silent Whisper is an offline-first, workspace-based messaging platform running on Node.js (Express + `ws`), Vite/React, PostgreSQL (Knex.js + pgvector), and local LLM services (Ollama/vLLM).

Please analyze the codebase for security vulnerabilities, logic flaws, authorization bypasses, and regressions against our project security baselines.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) to understand this project's established, deliberate conventions — e.g. only state-mutating or LLM-cost-incurring routes are audited by design; many workspace-scoped read routes are intentionally unaudited. Do not report a documented, deliberate design decision as a finding just because it deviates from a generic best practice; if you're unsure whether something is a deliberate tradeoff or a genuine gap, say so explicitly in the finding rather than asserting one or the other.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-security-review.md

Focus your review on the following critical security areas:

1. Authentication & Session Security
   - Password Hashing: Verify passwords are hashed using `bcryptjs` with async calls (`bcrypt.compare`/`bcrypt.hash`) and work factor ≥ 12. Confirm common-password denylists and length validation are enforced at signup.
   - Token Management: Ensure access tokens (15-min TTL) are stored exclusively in memory (React state/closure) and refresh tokens are stored hashed in the `refresh_tokens` table. Verify refresh tokens are delivered via `httpOnly`, `Secure`, `SameSite=Strict` cookies scoped to `/api/auth`.
   - Token Rotation & Revocation: Confirm refresh token rotation uses row-locked (`FOR UPDATE`) transactions and that replay detection invalidates all user tokens upon detecting a reused/revoked token. Check that `POST /api/auth/refresh` and WebSocket authentication re-check that the user's status is `ACTIVE`.

2. WebSocket Security & Handshake
   - Handshake Isolation: Confirm connections start unauthenticated (no room joins or data streaming) until an explicit `authenticate` event frame containing a valid JWT is processed.
   - Long-Lived Token Sweeps: Verify that WebSocket connections re-authenticate before token expiry and that un-renewed sockets are forcefully disconnected.
   - Payload & Connection Bounds: Ensure `WS_MAX_PAYLOAD_BYTES` (128 KiB limit) is enforced on incoming WebSocket frames and per-user socket connection limits are strictly applied.

3. Authorization & Access Control Boundaries
   - Centralized Enforcements: Verify that all workspace/channel membership checks go through centralized authorization utilities (`requireWorkspaceMember`, `requireChannelMember`) on every REST route and WebSocket handler.
   - Existence-Hiding Errors: Ensure non-members attempting to access private channels, direct messages, or group DMs receive 404 errors (or identical non-member error frames) to prevent disclosing resource existence.
   - System Admin vs. Message Content Boundary: Confirm that system administrators (`is_system_admin`) can perform structural management (workspace/channel creation, member management) but CANNOT read private channel or DM message content unless explicitly added to `channel_members`.
   - Cross-Workspace Injection: Validate that routes accepting both `:workspaceId` and `:channelId` verify that the target channel actually belongs to the specified workspace.

4. Forensic Security Audit Log Integrity
   - Append-Only Guarantees: Confirm that `audit_logs` grants permit only `SELECT` and `INSERT` for `app_runtime_user`, and that no application path issues `UPDATE`, `DELETE`, or `TRUNCATE` queries against `audit_logs`.
   - SHA-256 Hash Chaining: Check that every audit entry computes `curr_row_hash` over the canonical payload plus `prev_row_hash`.
   - Concurrent Write Serialization: Ensure audit writes use Postgres advisory locks (`pg_advisory_xact_lock`) within the database transaction to prevent chain forks under concurrent load.
   - Data Leak Prevention: Confirm that sensitive fields (passwords, JWT secrets, raw message/prompt contents) are NEVER written into `payload` JSONB fields in `audit_logs`.

5. Input Handling, Injection Prevention & LLM Security
   - Parameterized SQL: Confirm all database access uses Knex.js parameterized queries or bound parameters in `knex.raw()` calls.
   - XSS & Content Sanitization: Ensure all user-generated content (message bodies, entity descriptions) and LLM outputs are safely rendered (e.g., standard JSX text nodes, React components) and never passed directly to unsafe raw HTML sinks (`dangerouslySetInnerHTML`).
   - Prompt Injection Safeguards: In AI features (`summarize`, `extract-tasks`, `workspace-digest`, `entity summary`), verify that user message content is server-side truncated (`LLM_MAX_INPUT_CHARS`) and fenced with strict instruction delimiters.
   - SSRF & Gateway Protection: Confirm `LLM_BASE_URL` changes via settings endpoints validate against `ALLOWED_LLM_ORIGINS` to prevent Server-Side Request Forgery.

6. Rate Limiting & DoS Prevention
   - Authentication & Messaging Limits: Verify rate limiters are applied to login, signup, password resets, message sends, and task toggles.
   - AI Concurrency & Queueing: Ensure `LLM_MAX_CONCURRENT_REQUESTS` limits in-flight LLM calls via an in-memory queue (`AI_QUEUE_MAX_DEPTH`) and returns `503 Service Unavailable` with `X-Ai-Queue-Position` headers when capacity is reached.

7. Secrets & Environment Hygiene
   - Verify zero hardcoded secrets, API keys, JWT secrets, or DB passwords exist in source code, docs, or test fixtures. Check that `.env` and `.env.local` files are ignored in `.gitignore`.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-security-review.md` using this exact structure:

# Security Baseline Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level security evaluation and overall risk score]

---

## Findings Matrix

| Severity | Domain | Finding / Vulnerability | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [SEC-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Impact & Risk Scenario**: [Detailed breakdown of vulnerability and attack vector]
- **Recommended Remediation**:
  ```[language]
  // Exact, copy-pasteable security fix
  ```

## Architectural Wins & Compliant Patterns
[Highlight verified exemplary security implementations]
````

---

### 2. Application Performance & Scalability Review

````text
You are a Principal Performance & Systems Engineer conducting a code review of the Silent Whisper repository. Silent Whisper is an offline-first messaging platform built on Node.js (Express + `ws`), React (Vite), PostgreSQL (Knex.js + pgvector), and local LLM services (Ollama/vLLM).

Your objective is to evaluate the codebase against our Scalability Target: supporting 100 concurrent active users (WebSocket + REST) on a single backend instance within a tight resource envelope (8 vCPU, 30GB RAM, no GPU).

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) to understand this project's established, deliberate conventions. Do not report a documented, deliberate design decision as a finding just because it deviates from a generic best practice; if you're unsure whether something is a deliberate tradeoff or a genuine gap, say so explicitly in the finding rather than asserting one or the other.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-performance-review.md

Structure your analysis around the following core performance domains:

1. Database Performance & Query Optimization
   - Connection Pooling: Verify that the `pg` pool (`min: 2, max: 20`) is properly multiplexed and configured to prevent pool exhaustion under 100 concurrent REST + WebSocket requests without saturating PostgreSQL's `max_connections`.
   - Index Coverage: Check that covering indexes exist for all high-frequency authorization and query paths (e.g., `workspace_members(user_id)`, `channel_members(user_id)`, `messages(channel_id, created_at DESC)`, `refresh_tokens(user_id)`).
   - N+1 Queries & Joins: Audit API routes (especially channel list, message feeds, search, entity resolution, and task dashboards) for correlated subqueries or sequential `SELECT` loops that should be single `JOIN`s, pre-aggregated subqueries, or batch fetches.
   - Vector Search Overhead: Inspect `POST /api/search/semantic` to ensure pgvector cosine similarity scans are HNSW index-assisted (`vector_cosine_ops`), properly scoped by `channel_members` before distance calculation, and don't trigger full table sequential scans.

2. Node.js Event Loop & Thread Pool Health
   - CPU-Bound Sync Operations: Verify that CPU-heavy operations (e.g., `bcryptjs` hashing, heavy JSON serialization, or synchronous regex parsing) never block the main event loop. Confirm `bcrypt` calls use the async API (`bcrypt.hash`/`bcrypt.compare`) so work is offloaded to libuv threads.
   - Thread Pool Contention: Ensure high volumes of async bcrypt or crypto calls do not exhaust `UV_THREADPOOL_SIZE` and starve I/O operations.
   - Unbounded Memory Accumulation: Check for growing in-process state (connection registries, presence mappings, or rate-limiter buckets) that could cause memory leaks or excessive Garbage Collection (GC) pauses during prolonged 100-user runs.

3. WebSocket & Real-Time Broadcast Scaling
   - Fan-Out Efficiency: Audit room-based WebSocket broadcasts (`broadcastToRoom`, `sendToUser`) to ensure payload serialization occurs once per event rather than per connected client.
   - Connection Overhead: Verify that heartbeat sweeps and long-lived connection token checks run efficiently in batches rather than blocking the main thread during connection spikes.
   - Message Ingestion Queue: Confirm side effects of message creation (embedding generation, mention notifications, task parsing, entity linking) run asynchronously off the main message-send hot path via background workers (`messageSideEffectsWorker`, `embeddingWorker`).

4. Local LLM Proxy & Resource Isolation
   - In-Flight Concurrency: Verify that `LLM_MAX_CONCURRENT_REQUESTS` and `AI_QUEUE_MAX_DEPTH` strictly cap CPU-bound LLM generations (Ollama adapter) to prevent starvation of regular REST/WS traffic on an 8-vCPU host.
   - Abort & Stream Lifecycle: Ensure aborted client connections immediately trigger `AbortController` cancellation upstream to local Ollama/vLLM endpoints to free memory/CPU instantly.

5. Frontend Rendering & Asset Performance
   - Virtual Scrolling: Confirm `@tanstack/react-virtual` in `ChannelView.jsx` accurately measures dynamic row heights and prevents DOM node accumulation on long channel message feeds.
   - Component Re-rendering: Audit React state and context usage (`PresenceContext`, `ChatShell`) to verify high-frequency real-time events (presence ticks, typing signals) do not force full 3-column re-renders or un-memoized Markdown tokenization passes.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-performance-review.md` using this exact structure:

# Application Performance Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level performance evaluation and 100-user concurrency readiness assessment]

---

## Findings Matrix

| Severity | Domain | Finding / Bottleneck | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [PERF-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Impact & Bottleneck Scenario**: [Detailed breakdown of bottleneck under load]
- **Recommended Remediation**:
  ```[language]
  // Exact, copy-pasteable performance optimization
  ```

## Architectural Wins & Verified Optimizations
[Highlight verified exemplary performance engineering choices]
````

---

### 3. Code Efficiency & Resource Economy Review

````text
You are a Principal Software Architect conducting a Code Efficiency Review of the Silent Whisper repository. Silent Whisper is an offline-first, single-instance messaging platform built on Node.js (Express + `ws`), React (Vite), PostgreSQL (Knex.js + pgvector), and local LLM services (Ollama/vLLM).

Your objective is to evaluate the codebase for computational economy, memory overhead, redundant operations, algorithmic complexity, structural DRYness, and resource lifecycle management. Ensure the code does not waste CPU cycles, I/O bandwidth, database connections, or memory heap allocations.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) to understand this project's established, deliberate conventions. Do not report a documented, deliberate design decision as a finding just because it deviates from a generic best practice; if you're unsure whether something is a deliberate tradeoff or a genuine gap, say so explicitly in the finding rather than asserting one or the other.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-code-efficiency-review.md

Structure your analysis around the following core efficiency domains:

1. Algorithmic Complexity & Data Structures (Big-O Efficiency)
   - Search & Lookup Efficiency: Identify any O(N) linear array searches or array iterations that should be refactored into O(1) Set/Map key lookups (e.g., membership checks, channel ID mappings, user permission maps).
   - In-Memory Data Manipulation: Audit data formatting, filtering, and transformation loops (e.g., task parsing, Markdown tokenization, message history mapping) for redundant iterations, double-sorting, or unnecessary object cloning/spreads (`...obj`).
   - String & Serialization Economy: Ensure large JSON payloads (such as WebSocket broadcasts, LLM prompt construction, and audit hashing) are not serialized or parsed multiple times across layers for a single request.

2. I/O & Network Efficiency
   - Database Round-Trip Minimization: Identify places where multiple sequential SQL queries can be consolidated into single set-based queries, CTEs, or batched `WHERE IN` lookups.
   - Database Connection & Query Overhead: Check that database connections are released immediately after use and that queries select only necessary columns (`SELECT col1, col2` instead of `SELECT *` on large tables like `messages` or `audit_logs`).
   - WebSocket Broadcast Bandwidth: Ensure WebSocket event frames transmit minimal required diffs/payloads rather than echoing full database entities, and verify binary/text payloads are tightly bounded.

3. Memory Management & Garbage Collection (GC) Hygiene
   - Short-Lived Object Allocations: Locate hot code paths (e.g., message parsing, token verification, WebSocket frame handling) where transient objects, closures, or temporary arrays are allocated excessively, driving up GC pressure under load.
   - Unbounded Heap Collections: Inspect module-level caches, registries (`connectionRegistry`), in-process rate limiters, or event buffers for missing TTLs, missing eviction policies (LRU), or potential memory leaks over time.
   - Stream Processing: Confirm file uploads, large exports, and streaming AI responses use native streams/pipes (`res.write()`, `ReadableStream`) rather than buffering entire payloads in heap memory.

4. Structural Efficiency, DRYness & Code Reusability
   - Code Duplication & Abstraction Overlap: Identify duplicated business logic, repetitive validation routines, or redundant utility functions that should be consolidated into single shared modules (e.g., between REST and WebSocket handlers, or across LLM adapters).
   - Dead Code & Unused Abstractions: Locate dead functions, unused exports, obsolete fallback branches, or redundant middleware steps that consume bundle size or execution cycles without purpose.

5. Background Processing & Worker Efficiency
   - Queue Efficiency: Inspect background workers (`messageSideEffectsWorker`, `embeddingWorker`) to ensure batch processing (`SKIP LOCKED` loops) uses optimal chunk sizes and doesn't issue N+1 DB operations per queued job.
   - Idle & Polling Overhead: Verify background timers (`setInterval`, presence sweeps, health sweeps) sleep cleanly when no work is pending without spinning CPU cycles or thrashing the database.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-code-efficiency-review.md` using this exact structure:

# Code Efficiency Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation of computational economy, memory footprint, and code cleanliness]

---

## Findings Matrix

| Severity | Domain | Finding / Inefficacy | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [EFF-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Inefficacy & Impact**: [Detailed description of waste, leak, or algorithmic complexity]
- **Recommended Remediation**:
  ```[language]
  // Exact, copy-pasteable refactoring fix
  ```

## Architectural Wins & Efficient Patterns
[Highlight verified exemplary efficiency choices]
````

---

### 4. Air-Gapped Enclave Readiness Review

````text
You are a Systems & Infrastructure Operations Engineer conducting an Air-Gapped Deployment & Enclave Readiness Review of the Silent Whisper repository. Silent Whisper is designed to run completely offline on secure intranet infrastructure without access to external CDNs, public AI APIs, or internet-hosted assets.

Your objective is to audit the entire repository (frontend, backend, database, Docker scripts, dependencies) for hidden online dependencies, hardcoded host paths, or air-gap deployment blockers.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md`, `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline), and — specifically for this review — `docs/plans/active/SHIPMENT_PLAN.md` and `docs/plans/active/SHIPMENT_PUNCHLIST.md`. Those two are this project's own living, already-audited record of enclave readiness gaps, formally accepted risks, and what's already fixed — cross-reference your findings against them rather than rediscovering already-tracked items from scratch, and flag explicitly if something you found is NOT already tracked there. Do not report a documented, deliberate design decision (including a formally accepted risk) as a new finding just because it deviates from a generic best practice.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-enclave-readiness-review.md

Structure your analysis around the following domains:

1. Asset & Dependency Locality
   - External Asset Auditing: Scan all HTML, CSS, JS, and config files for external CDNs, Google Fonts, remote webfonts, public image URLs, or external script inclusions.
   - Package Tarball Locality: Ensure all npm packages and Docker base images rely purely on locally bundled or mirrored resources.

2. Offline Model & AI Adapter Isolation
   - Provider Offline Safety: Verify that local AI adapters (`ollamaAdapter.js`, `vllmAdapter.js`) communicate exclusively with local container origins (`LLM_BASE_URL`) and do not attempt telemetry or remote model fetches at runtime.
   - Embedding Isolation: Verify pgvector embedding generation relies strictly on locally hosted models (`all-minilm` via Ollama) without hitting remote Hugging Face or OpenAI endpoints.

3. Script Portability & Upgrade Safety
   - Enclave Install & Upgrade Scripts: Audit `scripts/airgap-install.sh` and `scripts/airgap-upgrade.sh` to ensure data persistence across image replacements, clean migration handling, and zero external network calls during execution.
   - Host Assumptions: Ensure scripts and Docker Compose setups do not hardcode absolute path assumptions tied to specific development machines.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-enclave-readiness-review.md` using this exact structure:

# Air-Gapped Enclave Readiness Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation of offline readiness and air-gap deployment risks]

---

## Findings Matrix

| Severity | Category | Finding / Risk | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Category] | [Short Description] | `path/to/file:line` |

---

## Detailed Findings & Remediations

### [ENCLAVE-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Category**: [Category]
- **Location**: `file/path.ext:LXX-LYY`
- **Risk Scenario**: [How this breaks in a zero-internet enclave]
- **Recommended Remediation**:
  ```[language]
  // Exact code or configuration fix for offline compliance
  ```

## Architectural Wins & Compliant Offline Patterns
[Highlight verified exemplary offline implementations]
````

---

### 5. Enterprise Data Governance & Audit Compliance Review

````text
You are a Governance, Risk, and Compliance (GRC) Security Auditor reviewing the Silent Whisper repository. Silent Whisper handles enterprise communication, audit logging, and private project discussions under strict multi-tenant authorization rules (organizations, workspaces, channels).

Your objective is to verify data retention, privacy boundaries, compliance logging, and tombstone/archival guarantees across PostgreSQL tables and application workflows.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) to understand this project's established, deliberate conventions — in particular, this codebase only audits state-mutating or LLM-cost-incurring routes by design; a large number of workspace-scoped reads (entity trending/experts, task dashboards, etc.) are intentionally unaudited, documented as such inline. Do not report every unaudited read route as a governance finding — distinguish a documented, deliberate scope boundary from a genuine, undocumented gap, and say so explicitly when you're not sure which one you're looking at.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-governance-audit-review.md

Structure your analysis around the following domains:

1. Data Isolation & Privacy Boundaries
   - Cross-Tenant Leakage: Verify that organization and workspace data boundaries are logically isolated at every layer (REST, WebSockets, Search, AI Prompts).
   - Private Content Exposure in Tooling: Confirm that private channel and DM contents are excluded from global search, trending entities, aggregate analytics, and un-audited admin surfaces.

2. Audit Trail Completeness & Tamper Resistance
   - Mandatory Event Coverage: Verify that all administrative, privilege-altering, and AI proxy operations trigger corresponding `audit_logs` records.
   - Immutable Tombstoning: Confirm that audit log verification (`verifyAuditChain`) cannot be bypassed or reset, and that no soft-delete or cascade rules touch `audit_logs`.

3. Message Retention & Revision Integrity
   - Edit & Revision Transparency: Confirm that edited messages preserve prior versions immutably in `message_edits` without update grants, and that entity-linking/notification models update accurately without losing historical record integrity.
   - Archival State Invariants: Verify that archived workspaces and organizations enforce strict write freezes across all API and WebSocket entry points.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-governance-audit-review.md` using this exact structure:

# Enterprise Data Governance & Audit Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation of data privacy controls, audit trail integrity, and compliance readiness]

---

## Findings Matrix

| Severity | Domain | Finding / Governance Risk | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [GOV-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Compliance Risk & Scenario**: [Detailed impact on data privacy or governance compliance]
- **Recommended Remediation**:
  ```[language]
  // Exact code or schema fix
  ```

## Architectural Wins & Verified Governance Patterns
[Highlight verified exemplary data governance implementations]
````

---

### 6. Maintainability & Code Quality Review

````text
You are a Staff Software Engineer conducting a Maintainability & Code Quality Review of the Silent Whisper repository. Silent Whisper is an offline-first messaging platform built on Node.js (Express + `ws`), React (Vite), PostgreSQL (Knex.js + pgvector), and local LLM services.

Your goal is to evaluate the codebase for long-term health, test thoroughness, technical debt, documentation drift, and code clarity.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) to understand this project's established, deliberate conventions. Do not report a documented, deliberate design decision as a finding just because it deviates from a generic best practice; if you're unsure whether something is a deliberate tradeoff or a genuine gap, say so explicitly in the finding rather than asserting one or the other.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-maintainability-review.md

Structure your analysis around the following domains:

1. Test Coverage & Edge-Case Completeness
   - Missing Negative & Boundary Tests: Audit `backend/tests/` and `frontend/src/` for missing failure-path tests (e.g., database connection drops, invalid state transitions, race conditions, edge-case validation inputs).
   - Test Isolation & Determinism: Check for test interdependencies, shared state leaks (`resetDb.js`), unhandled async timers, or flaky timing dependencies.

2. Error Handling & Resilience
   - Error Propagation: Verify that all Express routes and WebSocket event handlers catch errors gracefully without dropping connections, leaking raw driver exceptions, or crashing the process.
   - Fallback States: Ensure UI components and backend adapters degrade gracefully when services (like the LLM gateway or pgvector search) fail or time out.

3. Code Readability & Type Safety Constraints
   - Complex Method Smells: Identify monolithic handlers or deeply nested logical blocks that should be decomposed.
   - Validation Inconsistencies: Verify that request payload validation (`validation.js`) and UI form state validation share identical boundaries and constraints.

4. Documentation & Schema Alignment
   - Verify that `RUNBOOK.md`, `PROJECT_PLAN.md`, and `FEATURE_REQUEST.md` accurately reflect current implementation, environment variables, schema migrations, and route signatures.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-maintainability-review.md` using this exact structure:

# Maintainability & Code Quality Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation of codebase health, technical debt, and test coverage]

---

## Findings Matrix

| Severity | Domain | Finding / Debt Item | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.js:line` |

---

## Detailed Findings & Remediations

### [MAINT-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Maintenance Risk & Scenario**: [Impact on long-term code quality or developer velocity]
- **Recommended Remediation**:
  ```[language]
  // Exact code refactoring or test addition
  ```

## Architectural Wins & Clean Code Patterns
[Highlight verified exemplary maintainability choices]
````

---

### 7. Accessibility & HIG Compliance Review

````text
You are a Senior Frontend UX & Accessibility Engineer conducting an Accessibility and Design System Review of the Silent Whisper repository. Silent Whisper is built on React (Vite) and modeled on Apple HIG and Silent Lattice's visual design system (`global.css`).

Your goal is to audit the frontend for WCAG 2.1 AA compliance, Apple HIG standards, keyboard accessibility, screen reader semantics, and visual consistency across themes.

Determine the current application version from any of the three package.json files (backend/frontend/scripts — kept in version lockstep per CLAUDE.md's versioning rule) or the /health endpoint (e.g., v1.6.0). Obtain today's date in YYYY-MM-DD format.
Before analyzing, read `CLAUDE.md` and `PROJECT_PLAN.md` Section 3 (Security, Authorization, and Audit baseline) for this project's established conventions, and check `README.md`'s Known Issues section for accessibility gaps already tracked (e.g. a documented contrast shortfall in specific design tokens) so you don't re-report them as new discoveries — note their current status instead if you re-verify them.
Write your complete analysis directly into a Markdown file saved at:
docs/reviews/YYYY-MM-DD-accessibility-review.md

Structure your analysis around the following domains:

1. Keyboard Navigation & Focus Management
   - Focus Traps & Modals: Verify that modals, sheets (`Sheet.jsx`), and dropdown menus (`Menu.jsx`) trap focus properly, support `Escape` to close, and return focus to the trigger element upon closing.
   - Tabbability & Skip Links: Audit `WorkspaceSidebar`, channel feeds, and message composers to ensure all interactive elements have visible `:focus-visible` rings and logical tab ordering.

2. Touch Targets & Responsive Layout Boundaries
   - Hit Area Sizing: Ensure all buttons, controls, close triggers, and list items meet the Apple HIG minimum hit target size of 44×44pt.
   - Overflow & Layout Squeezing: Inspect flex/grid layouts (e.g., `WorkspaceSidebar`, channel headers) for proper `min-width: 0` usage and truncation to prevent visual clipping or scroll leaks.

3. Semantics, ARIA & Screen Readers
   - Accessible Names & Roles: Verify that custom controls, SVG icons (`lucide-react`), and status indicators use appropriate `aria-label`, `aria-hidden`, `role="button"`, or `role="dialog"` attributes.
   - Dynamic Content Announcements: Confirm real-time WebSocket events (incoming mentions, live toasts, background tasks) use live regions (`aria-live="polite"`).

4. Theme Parity & Visual Contrast
   - WCAG AA Contrast: Verify text colors (`--text-1` through `--text-4`) meet contrast ratios (4.5:1 for normal text, 3:1 for large text) against backgrounds in both Light and Dark themes.
   - Motion Preference: Verify that animations and transitions respect `prefers-reduced-motion`.

---

### Output Format Requirement

Write the complete analysis to `docs/reviews/YYYY-MM-DD-accessibility-review.md` using this exact structure:

# Accessibility & HIG Review — Silent Whisper

**App Version Reviewed**: `[Insert Version, e.g., v1.6.0]`
**Review Date**: `YYYY-MM-DD`

---

## Executive Summary
[High-level evaluation of accessibility compliance and HIG alignment]

---

## Findings Matrix

| Severity | Domain | Finding / Violation | Location |
|---|---|---|---|
| Critical / High / Med / Low / Info | [Sub-Domain] | [Short Description] | `path/to/file.jsx:line` |

---

## Detailed Findings & Remediations

### [A11Y-01] Title of Finding
- **Severity**: Critical | High | Medium | Low | Informational
- **Domain**: [Sub-domain]
- **Location**: `file/path.ext:LXX-LYY`
- **Violation & User Impact**: [Detailed accessibility issue and user impact scenario]
- **Recommended Remediation**:
  ```[language]
  // Exact JSX or CSS fix
  ```

## Architectural Wins & Verified HIG Patterns
[Highlight verified exemplary accessibility implementations]
````
