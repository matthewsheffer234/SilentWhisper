# Changelog

Tracks every version actually cut for shipment into an air-gapped enclave — one entry per **release**, not per dev session. For that finer-grained history (every change, every deviation from a design, every test run) see `PROJECT_PLAN.md` Section 11's implementation log; for the backlog those changes came from, see `FEATURE_REQUEST.md`. This file exists for one purpose: given a version currently installed in an enclave, know what's different in the next one, and what an upgrade will actually touch, without reading either of those in full.

See `RUNBOOK.md`'s "Enclave Upgrade" section for the upgrade procedure itself (`scripts/airgap-upgrade.sh`).

## Versioning

`SILENTWHISPER_VERSION` (the tag on the images `scripts/build-release-images.sh` produces, and the version this file's headings track) follows semver-ish rules, read from the enclave operator's perspective:

- **PATCH** (`1.0.x`) — bug fixes only. No new migration, no new required env var, no behavior change beyond "the bug is gone."
- **MINOR** (`1.x.0`) — new features and/or new migrations, always additive/non-destructive (new tables/columns, never a dropped or renamed one; new env vars always have a working default). `scripts/airgap-upgrade.sh` handles these unattended.
- **MAJOR** (`x.0.0`) — anything an operator must act on beyond running the upgrade script: a destructive or manually-reviewed migration, a required env var with no safe default, a breaking API/config change. Called out explicitly in that version's entry, with the manual step spelled out — never silently bundled into a routine upgrade.

Each entry lists the migrations and new env vars it introduces, so an operator can tell what an upgrade will change before running it.

**Cadence, stated explicitly rather than left to guesswork**: in practice this means roughly one release per shipped commit that touches `backend/`, `frontend/`, `scripts/`, or `database/migrations/` — see `v1.1.0` and `v1.1.1` as the pattern, two releases the same day for two separate commits, not batched into a periodic drop. Small, tightly-scoped releases keep each individual upgrade's blast radius easy to reason about and roll back; batching several unrelated changes into one version number just makes `scripts/airgap-upgrade.sh`'s all-or-nothing bring-up riskier for no real benefit. `CLAUDE.md`'s Rules of Engagement (`PROJECT_PLAN.md` Section 9) makes this a standing requirement, not a one-off — every such commit gets its `CHANGELOG.md` entry and version bump in the same commit, not a follow-up step.

## [1.3.0] — 2026-07-24

**Migrations**: `0025_message_sentiment_scores.js` — additive (new table, no changes to existing tables). No data loss, nothing to review before upgrading.
**New env vars** (all optional, safe defaults): `ADMIN_ANALYTICS_MIN_SHARED_CHANNELS` (default `2`), `SENTIMENT_POSITIVE_ANCHORS`/`SENTIMENT_NEGATIVE_ANCHORS` (default anchor phrases), `SENTIMENT_MIN_BUCKET_MESSAGES` (default `5`).

- Added the two remaining Admin Analytics Dashboard tabs (`FEATURE_REQUEST.md`, originally ranked entries 5 and 6): "Collaboration" (`GET /api/admin/analytics/collaboration/membership-graph` — structural channel-membership overlap between users; `.../interaction-trend` — reply-based cross-person interaction volume over time) and "Sentiment Trends" (`GET /api/admin/analytics/sentiment-trend` — an approximate per-bucket tone average derived from the embedding already computed for semantic search, never a second LLM call). Both are system-admin-only, metadata/embedding-only reads — never message content — and structurally exclude DM/group-DM channels, same as the Activity tab. `scope=user` on the sentiment endpoint (the one variant that's individual tone-monitoring rather than a many-person average) is audited; every other route/scope is not. See `PROJECT_PLAN.md` Section 11, "Admin Analytics Dashboard: collaboration structure and interaction trend, and aggregate semantic/sentiment trend" (2026-07-24), for full detail.

Full diff: `git diff v1.2.0..v1.3.0`.

## [1.2.0] — 2026-07-24

**Migrations**: `0024_admin_analytics_index.js` — additive (new index, `idx_messages_created_at`, no column/table changes). No data loss, nothing to review before upgrading.
**New env vars**: none (`adminAnalyticsLimiter`'s 30 req/60s ceiling is a fixed constant, not env-configurable, matching `tasks.js`'s own `MAX_TASK_DASHBOARD_WINDOW_DAYS` precedent).

- Added a system-admin-only Admin Analytics dashboard (`FEATURE_REQUEST.md` entry 5, "Admin Analytics Dashboard — activity and engagement metrics"): `GET /api/admin/analytics/activity` (message/active-user counts bucketed by day or week, scoped to an organization/workspace/channel or everything a system admin administers) and `GET /api/admin/analytics/dormant-channels` (channels with no top-level message in N days, computed live from each channel's own last-activity timestamp, never a stored flag). Both are pure aggregate reads over `messages.created_at`/`channel_id`/`user_id` and `channel_members` — never `messages.content` — and structurally exclude DM/group-DM channels (`channels.workspace_id IS NOT NULL`). New `AdminAnalyticsPanel.jsx`, reachable from the Admin hub. See `PROJECT_PLAN.md` Section 11, "Admin Analytics Dashboard: activity and engagement metrics" (2026-07-24), for full detail, including a real Postgres `GROUP BY`/parameter-binding bug found and fixed during implementation.

Full diff: `git diff v1.1.1..v1.2.0`.

## [1.1.1] — 2026-07-24

**Migrations**: none. **New env vars**: none.

Two real bugs in `scripts/airgap-upgrade.sh` found by actually rehearsing it end-to-end against an isolated throwaway stack (a real v1.0.0 install upgraded to a real v1.1.0, on the same host as a live deployment) — the "not yet rehearsed" gap `v1.1.0`'s entry and `RUNBOOK.md` both flagged honestly instead of glossing over, closed the same day:

- The script hardcoded `http://localhost:8101` for every health check instead of respecting `BACKEND_HOST_PORT` (`docker-compose.yml`'s own port-remap variable). On a host already running a real deployment on the default port, a rehearsal remapping the port to avoid colliding would have had every check silently query the *other*, real instance instead of the rehearsal stack — a false-positive/false-negative risk, not just an inconvenience. Fixed: `BASE_URL` is now resolved from `BACKEND_HOST_PORT` once `.env` is loaded, and every check uses it.
- The preflight's "read the currently-running version off `GET /health`" step has no fallback for a backend that predates the `version` field entirely — which is exactly `v1.0.0`, since that field didn't exist until `v1.1.0`. Unfixed, this would have hard-failed the very first upgrade any real enclave ever runs. Fixed: an explicit `ASSUME_PREVIOUS_VERSION` env var lets the operator confirm what's running when `/health` can't report it itself — required, not guessed, same "fail closed, make the operator say it out loud" posture `CONFIRM_MAJOR_UPGRADE` already uses.

Both were found and fixed *before* being exercised for real, then the same rehearsal was re-run clean end-to-end: 22→23 migrations applied, grants re-verified, all pre-existing data (users, workspace, channel, messages, a DM, and its message) confirmed byte-for-byte unchanged by direct row-count and content comparison before/after, and the new `v1.1.0` auto-archive feature itself exercised against that pre-existing DM (backdating it past a newly-set threshold correctly excluded it from `GET /api/direct-messages`) — proof the feature works on data that predates it, not just on data created after upgrading. See `PROJECT_PLAN.md` Section 11, "Rehearsing the enclave upgrade script end-to-end" (2026-07-24), for the full walkthrough.

Full diff: `git diff v1.1.0..v1.1.1`.

## [1.1.0] — 2026-07-24

**Migrations**: `0023_dm_auto_archive.js` — additive (new nullable `users.dm_auto_archive_days` column). No data loss, nothing to review before upgrading.
**New env vars** (both optional, safe defaults): `DM_AUTO_ARCHIVE_DEFAULT_DAYS` (default `90`), `DM_AUTO_ARCHIVE_MAX_DAYS` (default `3650`).

- Added ephemeral direct messages and group DMs via a per-user auto-archive threshold (`FEATURE_REQUEST.md` entry 2). `DIRECT`/`GROUP_DM` channels a user hasn't touched in a while quietly drop out of that user's own channel list — never deleted, never hidden from a DBA, always recomputed live from the channel's actual last-activity timestamp — and a new message brings a dormant one right back automatically. New self-service `PATCH /api/auth/me/dm-settings` lets each user set their own threshold (`0` = never archive). See `PROJECT_PLAN.md` Section 11, "Ephemeral direct messages and group DMs via per-user auto-archive" (2026-07-24), for full detail.
- Added this file, `scripts/airgap-upgrade.sh`, and a `version` field on `GET /health` — the tooling this changelog itself depends on. See `RUNBOOK.md`'s "Enclave Upgrade" section.

Full diff: `git diff v1.0.0..v1.1.0` (or `v1.0.0...v1.1.0` for just this range's commits).

## [1.0.0] — 2026-07-23

Baseline. The version installed in the air-gapped enclave as of 2026-07-24, tagged retroactively at commit `fbbf9bd` (the last commit before this file started tracking releases) once that fact was confirmed directly by the enclave operator — this repo has no independent visibility into what's physically running there. No changelog entries before this point; everything prior lives in `PROJECT_PLAN.md` Section 11's full implementation log, uncategorized by release.
