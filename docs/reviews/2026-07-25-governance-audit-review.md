# Enterprise Data Governance & Audit Review — Silent Whisper

**App Version Reviewed**: `v1.6.0`
**Review Date**: `2026-07-25`

---

## Executive Summary
Governance posture: **Strong audit immutability, medium privacy risk in derived AI content**. Audit-chain integrity is well implemented: append-only DB grants, advisory-locked hash-chain writes, and a verification path are present. The codebase also deliberately scopes read-route audit coverage to state-mutating or LLM-cost-incurring operations, and I did not treat intentionally unaudited aggregate reads as generic findings.

The notable governance gap is cached entity summary visibility. A workspace-visible summary can be generated from private references by a broad-access member, then shown to a narrower-access member. A second lower-grade concern is that derived governance artifacts can be missed permanently if best-effort queue inserts fail.

---

## Findings Matrix

| Severity | Domain | Finding / Governance Risk | Location |
|---|---|---|---|
| Medium | Privacy Boundary | Cached entity summaries may reveal derived private-channel information | `backend/src/routes/entities.js:682` |
| Low | Derived Records | Queue insert failures can permanently omit notifications, entity links, embeddings, and sentiment scores | `backend/src/services/messageSideEffectsQueue.js:21` |
| Low | Audit Scope | Streaming AI audit writes fail open after partial response streaming | `backend/src/llm/aiService.js:118` |

---

## Detailed Findings & Remediations

### [GOV-01] Entity Summary Cache Is Workspace-Visible Instead Of Reader-Scoped
- **Severity**: Medium
- **Domain**: Privacy Boundary
- **Location**: `backend/src/routes/entities.js:L682-L702`, `backend/src/routes/entities.js:L715-L740`
- **Compliance Risk & Scenario**: A user with access to a private channel can generate an entity summary from references in that channel. The stored row is then returned by the summary GET route to any workspace member who can open the entity, regardless of their access to every cited channel. This weakens the project baseline that private channel and DM contents are not exposed through search, AI, or admin tooling.
- **Recommended Remediation**:
  ```js
  // Option A: cache summaries per generator access set.
  await db('entity_summaries').insert({
    entity_id: entityId,
    summary_text: result.text,
    citations: JSON.stringify(citations),
    visible_channel_ids: JSON.stringify([...new Set(citations.map((c) => c.channelId))]),
    generated_by: req.user.id,
  });
  ```

### [GOV-02] Best-Effort Queue Inserts Can Leave Permanent Governance Gaps
- **Severity**: Low
- **Domain**: Derived Records
- **Location**: `backend/src/services/messageSideEffectsQueue.js:L21-L31`, `backend/src/search/embeddingQueue.js:L10-L22`
- **Compliance Risk & Scenario**: Message creation succeeds even if side-effect or embedding queue insertion fails. That preserves primary message data, but downstream records such as mention notifications, entity relationships, semantic search vectors, and sentiment scores can be missing forever unless an operator notices logs and repairs them.
- **Recommended Remediation**:
  ```js
  // Add an operator-safe reconciliation script and scheduled worker pass.
  await enqueueMissingEmbeddingJobs(db);
  await enqueueMissingMessageSideEffectJobs(db);
  ```

### [GOV-03] Streaming AI Audit Writes Are Not Guaranteed
- **Severity**: Low
- **Domain**: Audit Scope
- **Location**: `backend/src/llm/aiService.js:L118-L124`
- **Compliance Risk & Scenario**: The streaming helper swallows audit-write errors after generation completes. The tradeoff is understandable once body bytes may already be sent, but compliance evidence for a successful AI operation can be absent during a transient DB issue.
- **Recommended Remediation**:
  ```js
  try {
    await onBeforeEnd(result);
  } catch (err) {
    await appendAuditRetryOutbox(db, redactedAuditEvent);
  }
  ```

## Architectural Wins & Verified Governance Patterns
- `audit_logs` has SELECT/INSERT-only runtime grants and explicit UPDATE/DELETE/TRUNCATE revocation.
- `message_edits` has SELECT/INSERT-only runtime grants, preserving revision history.
- Admin audit dashboard access and audit verification attempts are themselves audited.
- Admin analytics routes explicitly exclude DM and group-DM channels by `workspace_id IS NOT NULL`.
