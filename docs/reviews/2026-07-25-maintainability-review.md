# Maintainability & Code Quality Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
Maintainability health: **Good, with targeted refactoring and test gaps**. The repository is heavily commented, uses shared authz and AI helpers, and has broad backend test coverage across auth, authorization, AI, search, analytics, entities, messages, and workers. The largest maintainability issue is that the AI concurrency primitive has no cancellation abstraction, forcing callers to reason about abort behavior outside the queue. Frontend accessibility behavior is mostly implemented, but automated accessibility coverage is still thin.

---

## Findings Matrix

| Severity | Domain | Finding / Debt Item | Location |
|---|---|---|---|
| Medium | Resilience / Shared Primitive | AI concurrency gate lacks cancellation semantics | `backend/src/llm/concurrencyGate.js:33` |
| Low | Test Coverage | Accessibility behavior is mostly manual/e2e rather than covered by focused unit tests | `frontend/src/components/Menu.jsx:84` |
| Low | Code Complexity | `ChatShell.jsx` remains a large orchestration component with many coupled workflows | `frontend/src/components/ChatShell.jsx:179` |

---

## Detailed Findings & Remediations

### [MAINT-01] AI Queue Cancellation Is Not A First-Class Contract
- **Severity**: Medium
- **Domain**: Resilience / Shared Primitive
- **Location**: `backend/src/llm/concurrencyGate.js:L33-L46`, `backend/src/services/entitySummaryService.js:L35-L47`
- **Maintenance Risk & Scenario**: Streaming AI routes pass abort signals to adapters, and entity summary creates an `AbortController`, but the queue itself cannot remove queued work. Future AI features must rediscover this edge case unless cancellation becomes part of `acquireSlot()`.
- **Recommended Remediation**:
  ```js
  export function acquireSlot(maxConcurrent, { signal, onQueued } = {}) {
    // Implement queue entry removal on signal.abort and add unit tests for:
    // queued abort, immediate abort, FIFO preservation, and release after abort.
  }
  ```

### [MAINT-02] Accessibility Semantics Need Focused Tests
- **Severity**: Low
- **Domain**: Test Coverage
- **Location**: `frontend/src/components/Menu.jsx:L84-L181`, `frontend/src/components/Sheet.jsx:L83-L116`
- **Maintenance Risk & Scenario**: The `Menu` and `Sheet` primitives contain hand-rolled keyboard/focus behavior. `Sheet` is strong, but regressions in Escape, Tab wrapping, aria roles, and menu highlighting can slip through without focused component tests.
- **Recommended Remediation**:
  ```jsx
  test('menu supports arrow navigation, enter selection, escape close, and focus return', async () => {
    // Render Menu, tab/click trigger, assert role="menu",
    // arrow to item, press Enter, assert callback and trigger focus.
  });
  ```

### [MAINT-03] ChatShell Owns Too Many Workflow Responsibilities
- **Severity**: Low
- **Domain**: Code Complexity
- **Location**: `frontend/src/components/ChatShell.jsx:L179-L938`
- **Maintenance Risk & Scenario**: `ChatShell` coordinates channel selection, WebSocket reconciliation, mentions, notifications, tasks, direct messages, entity panels, digest panels, and thread state. The use of callbacks helps, but feature work repeatedly touches this one component, increasing regression risk.
- **Recommended Remediation**:
  ```jsx
  // Extract narrow hooks:
  const channelState = useChannelState({ selectedWorkspaceId });
  const realtime = useRealtimeReconciliation({ channelState, taskState });
  const panels = useChatPanels();
  ```

## Architectural Wins & Clean Code Patterns
- Auth and membership decisions are centralized in `authz/membershipService.js`.
- AI streaming behavior is shared through `runStreamingCompletion()`.
- Database migrations include explanatory comments for non-obvious indexing and grant decisions.
- Backend tests are extensive and include negative authorization cases.
