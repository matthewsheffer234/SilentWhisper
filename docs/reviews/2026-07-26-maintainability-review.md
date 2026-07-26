# 2026-07-26 Maintainability Review

Prompt: `docs/code-review-prompts.md` -> Maintainability & Complexity Review.

Scope reviewed from current source: major frontend containers/primitives, backend route/service boundaries, authz/audit/LLM service modules, workers, migrations, and scripts.

## Findings

### Low: `ChatShell.jsx` remains the main maintainability hotspot

`frontend/src/components/ChatShell.jsx` is 1,281 lines and `ChatShellInner` owns broad application state across orgs, workspaces, channels, messages, threads, direct messages, notifications, admin panels, tasks, digest, and knowledge explorer (`frontend/src/components/ChatShell.jsx:103-173`).

The file is coherent but too central. Future features are likely to touch it, increasing regression risk. Extracting message/thread reconciliation, selection/navigation state, and modal routing into focused hooks would reduce blast radius.

### Low: prompt-template comments disagree with the current admin-setting guard

`promptTemplates.js` says legacy `v1` templates remain reachable via explicit `app_settings` override (`backend/src/llm/promptTemplates.js:13-16`). `settingsService.js` now only allows `v2` as an admin-settable prompt version and documents that `v1` is historical/test fallback only (`backend/src/llm/settingsService.js:20-27`).

The runtime behavior is safer than the stale comment implies. Update the comment so future reviewers and operators do not think a database override can intentionally select `v1` through supported admin settings.

### Low: completed job retention is documented in code but not centralized in operations docs

The side-effect worker explains why completed rows are retained and why cleanup is deferred (`backend/src/workers/messageSideEffectsWorker.js:164-178`). That rationale lives only near the worker implementation.

If retention is deliberate, document it near backup/operations sizing. If it is temporary, track the cleanup policy as a first-class follow-up instead of leaving it embedded in a code comment.

## Verified Strengths

- Backend authz is centralized in `membershipService.js` and reused by REST and WebSocket paths.
- LLM provider logic is separated behind settings/adapters/templates, with validation concentrated in `settingsService.js` and `validation.js`.
- Shared frontend primitives (`Sheet`, `Menu`, `PeoplePicker`) have clear responsibilities and relevant unit/E2E coverage.
- Enclave install and upgrade scripts are verbose, fail-closed, and intentionally standalone rather than hidden behind shared mutable shell helpers.
