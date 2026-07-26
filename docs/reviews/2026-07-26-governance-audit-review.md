# 2026-07-26 Governance / Audit Review

Prompt: `docs/code-review-prompts.md` -> Governance / Audit / Compliance Review.

Scope reviewed from current source: audit service, audit retry queue, admin and AI routes, membership/org/workspace lifecycle routes, message edit/task/AI/search audit payloads, grants migrations, and operational install/upgrade scripts.

## Findings

### Low: completed side-effect job retention is undecided

`message_side_effect_jobs` is deliberately retained after successful processing so reconciliation can tell that side effects were already enqueued (`backend/src/workers/messageSideEffectsWorker.js:164-178`). The code also states there is no retention/cleanup pass yet.

From a governance standpoint, this is durable operational metadata tied to message IDs. Decide whether it is part of the long-term audit/operations record, or add a retention/compaction rule and document it in the runbook.

### Low: accepted enclave evidence gaps should be converted into attached install artifacts

The current README records two accepted operational risks: no real vLLM hardware run before ship and no one-shot clean-host installer run on this host (`README.md:33-36`). The installer now emits a report and checks audit-chain integrity, grants, vLLM behavior, and app-level AI summarize, but this review did not have an enclave host/artifacts to execute it.

For compliance-style handoff, keep the risk acceptance, but require the first real `install-report-*` and any vLLM gateway logs as release evidence.

## Verified Controls

- `audit_logs` are hash-chained with canonical JSON payloads and serialized append using a Postgres advisory transaction lock.
- Audit retry uses a separate mutable outbox; immutable audit rows are not reused as the retry queue.
- Runtime database grants keep `audit_logs` insert/select-only while allowing normal CRUD only on mutable operational tables.
- Message edit audit payloads include lengths and metadata, not raw old/new message content.
- AI summary/task/digest/search audit events log scoped metadata and counts rather than prompt bodies or full query content.
- Membership changes, invitations, archive/unarchive, ownership transfer, user disable/enable, password resets, AI settings updates, entity metadata/relationship edits, message edits, and task toggles have audit coverage in the reviewed route paths.
- Archived scope write-freeze checks are present on organization/workspace membership and invitation write paths reviewed, with redemption-time checks for stale invitations.
