# Changelog

Tracks every version actually cut for shipment into an air-gapped enclave — one entry per **release**, not per dev session. For that finer-grained history (every change, every deviation from a design, every test run) see `PROJECT_PLAN.md` Section 11's implementation log; for the backlog those changes came from, see `FEATURE_REQUEST.md`. This file exists for one purpose: given a version currently installed in an enclave, know what's different in the next one, and what an upgrade will actually touch, without reading either of those in full.

See `RUNBOOK.md`'s "Enclave Upgrade" section for the upgrade procedure itself (`scripts/airgap-upgrade.sh`).

## Versioning

`SILENTWHISPER_VERSION` (the tag on the images `scripts/build-release-images.sh` produces, and the version this file's headings track) follows semver-ish rules, read from the enclave operator's perspective:

- **PATCH** (`1.0.x`) — bug fixes only. No new migration, no new required env var, no behavior change beyond "the bug is gone."
- **MINOR** (`1.x.0`) — new features and/or new migrations, always additive/non-destructive (new tables/columns, never a dropped or renamed one; new env vars always have a working default). `scripts/airgap-upgrade.sh` handles these unattended.
- **MAJOR** (`x.0.0`) — anything an operator must act on beyond running the upgrade script: a destructive or manually-reviewed migration, a required env var with no safe default, a breaking API/config change. Called out explicitly in that version's entry, with the manual step spelled out — never silently bundled into a routine upgrade.

Each entry lists the migrations and new env vars it introduces, so an operator can tell what an upgrade will change before running it.

## [1.1.0] — 2026-07-24

**Migrations**: `0023_dm_auto_archive.js` — additive (new nullable `users.dm_auto_archive_days` column). No data loss, nothing to review before upgrading.
**New env vars** (both optional, safe defaults): `DM_AUTO_ARCHIVE_DEFAULT_DAYS` (default `90`), `DM_AUTO_ARCHIVE_MAX_DAYS` (default `3650`).

- Added ephemeral direct messages and group DMs via a per-user auto-archive threshold (`FEATURE_REQUEST.md` entry 2). `DIRECT`/`GROUP_DM` channels a user hasn't touched in a while quietly drop out of that user's own channel list — never deleted, never hidden from a DBA, always recomputed live from the channel's actual last-activity timestamp — and a new message brings a dormant one right back automatically. New self-service `PATCH /api/auth/me/dm-settings` lets each user set their own threshold (`0` = never archive). See `PROJECT_PLAN.md` Section 11, "Ephemeral direct messages and group DMs via per-user auto-archive" (2026-07-24), for full detail.
- Added this file, `scripts/airgap-upgrade.sh`, and a `version` field on `GET /health` — the tooling this changelog itself depends on. See `RUNBOOK.md`'s "Enclave Upgrade" section.

Full diff: `git diff v1.0.0..v1.1.0` (or `v1.0.0...v1.1.0` for just this range's commits).

## [1.0.0] — 2026-07-23

Baseline. The version installed in the air-gapped enclave as of 2026-07-24, tagged retroactively at commit `fbbf9bd` (the last commit before this file started tracking releases) once that fact was confirmed directly by the enclave operator — this repo has no independent visibility into what's physically running there. No changelog entries before this point; everything prior lives in `PROJECT_PLAN.md` Section 11's full implementation log, uncategorized by release.
