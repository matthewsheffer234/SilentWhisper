# Security Baseline Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
Static security review score: **B+ / Moderate residual risk**. Core baselines are strong: async bcrypt with a minimum work factor of 12, refresh-token hashing and row-locked rotation, in-memory access tokens, authenticated WebSocket frames, max WS payloads, centralized membership checks, and an advisory-locked audit hash chain are all present. No critical auth bypass or obvious injection path was found.

The main security concern is a privacy boundary in cached entity summaries: summaries are generated from the requesting user's authorized references, but the cached summary text is later returned to any workspace member, even if that later reader cannot access all cited channels. A secondary DoS concern exists in AI queue handling because queued requests cannot be removed when the client disconnects before acquiring a slot.

---

## Findings Matrix

| Severity | Domain | Finding / Vulnerability | Location |
|---|---|---|---|
| Medium | Privacy / AI Content Boundary | Cached entity summaries can expose private-channel-derived text to other workspace members | `backend/src/routes/entities.js:682` |
| Medium | DoS / AI Queueing | AI wait queue has no cancellation path for clients disconnected before slot acquisition | `backend/src/llm/concurrencyGate.js:33` |
| Low | Audit Durability | AI streaming audit callback logs and swallows audit-write failures after body streaming begins | `backend/src/llm/aiService.js:118` |

---

## Detailed Findings & Remediations

### [SEC-01] Cached Entity Summaries Cross Channel-Content Boundaries
- **Severity**: Medium
- **Domain**: Privacy / AI Content Boundary
- **Location**: `backend/src/routes/entities.js:L682-L702`
- **Impact & Risk Scenario**: `POST /workspaces/:workspaceId/entities/:entityId/ai/summary` builds a summary from references visible to the requesting user, but `GET /workspaces/:workspaceId/entities/:entityId/ai/summary` returns the latest cached summary to any workspace member. The inline comment acknowledges that a broader-access member can generate a summary from channels a later reader cannot open. That makes the summary row a derived-content channel unless the text is filtered, scoped, or separately authorized.
- **Recommended Remediation**:
  ```js
  // Store the generator's readable channel set with each summary, then require
  // the reader to still be a member of every cited channel before returning it.
  const citedChannelIds = summary.citations.map((c) => c.channelId);
  const visibleCount = await db('channel_members')
    .where('user_id', req.user.id)
    .whereIn('channel_id', citedChannelIds)
    .countDistinct('channel_id as count')
    .first();
  if (Number(visibleCount.count) !== new Set(citedChannelIds).size) {
    throw new NotFoundError('Entity summary not found');
  }
  ```

### [SEC-02] Disconnected Clients Remain In The AI Wait Queue
- **Severity**: Medium
- **Domain**: DoS / Resource Exhaustion
- **Location**: `backend/src/llm/concurrencyGate.js:L33-L46`, `backend/src/llm/aiService.js:L65-L82`
- **Impact & Risk Scenario**: `acquireSlot()` stores only a resolver function. If a client disconnects while queued, the request remains queued and later consumes a generation slot before the abort signal can stop the provider call. A small burst of abandoned AI requests can therefore waste scarce local LLM capacity.
- **Recommended Remediation**:
  ```js
  export function acquireSlot(maxConcurrent, { onQueued, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('AI request aborted'));
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return Promise.resolve();
    }
    if (queue.length >= config.llm.queueMaxDepth) {
      return Promise.reject(new Error('AI queue is full'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve };
      const abort = () => {
        queue = queue.filter((item) => item !== entry);
        reject(new Error('AI request aborted'));
      };
      entry.resolve = () => {
        signal?.removeEventListener?.('abort', abort);
        resolve();
      };
      signal?.addEventListener?.('abort', abort, { once: true });
      queue.push(entry);
      onQueued?.(queue.length);
    });
  }
  ```

### [SEC-03] Streaming AI Audit Failures Are Fail-Open
- **Severity**: Low
- **Domain**: Audit Coverage
- **Location**: `backend/src/llm/aiService.js:L118-L124`
- **Impact & Risk Scenario**: `runStreamingCompletion()` catches `onBeforeEnd` failures, logs them, and still completes the response. The comment explains why partial streaming cannot be retroactively failed, but the result is a successful AI operation without a corresponding audit row during transient DB failures.
- **Recommended Remediation**:
  ```js
  // Add a durable local retry queue for failed audit events and emit a metric.
  await enqueueAuditRetry({
    actorId: req.user.id,
    actionType: 'AI_SUMMARY_REQUESTED',
    payload: redactedPayload,
  });
  ```

## Architectural Wins & Compliant Patterns
- Refresh tokens are hashed and rotated inside row-locked transactions (`backend/src/auth/refreshTokens.js:34`).
- WebSockets start unauthenticated, enforce `maxPayload`, re-check `ACTIVE` user status, and sweep expired tokens (`backend/src/ws/server.js:31`).
- Audit writes use a transaction-scoped Postgres advisory lock and hash chaining (`backend/src/audit/auditService.js:84`).
- Security headers, narrow CORS, JSX-safe rendering, and no `dangerouslySetInnerHTML` were verified.
