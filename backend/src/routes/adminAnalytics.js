import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireSystemAdmin } from '../authz/membershipService.js';
import { adminAnalyticsLimiter } from '../auth/rateLimit.js';
import { assertUuid, assertEnum, assertBoundedInt } from '../validation.js';

// FEATURE_REQUEST.md entry 5 (Admin Analytics Dashboard — activity and
// engagement metrics). Every query in this file reads only
// messages.created_at / channel_id / user_id and channel_members —
// never messages.content — and is scoped to non-DM channels by construction
// (channels.workspace_id IS NOT NULL), never DM/GROUP_DM (workspace_id NULL,
// per directMessages.js's own existing comment). This is a deliberate
// boundary, not an accident of the join shape: aggregating how much a
// person talks in their DMs is a sharper privacy concern than a per-channel
// route existing at all, especially given the shipped ephemeral-DM/
// auto-archive entry exists specifically to shrink DM footprint and
// visibility. Entries 6/7 (collaboration graph, sentiment trend) share this
// file, this router, and adminAnalyticsLimiter.
export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.use(requireAuth);
adminAnalyticsRouter.use(adminAnalyticsLimiter);

// Sanity caps on how far back a single request may ever reach — local
// constants, not admin-editable app_settings or env vars, matching
// tasks.js's own MAX_TASK_DASHBOARD_WINDOW_DAYS precedent for the same kind
// of "bounded rolling window" query.
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const SCOPE_TYPES = ['organization', 'workspace', 'channel'];
const BUCKET_TYPES = ['day', 'week'];

function parseWindowDays(query) {
  return query.windowDays !== undefined
    ? assertBoundedInt(query.windowDays, { min: 1, max: MAX_WINDOW_DAYS }, 'windowDays')
    : DEFAULT_WINDOW_DAYS;
}

// scope/scopeId are a matched pair — omitting both reports across every
// organization (authorized because a system admin already has structural
// authority everywhere and this never reads message content); giving one
// without the other is a 400, not a silent fallback to "everything."
function parseScope(query) {
  if (query.scope === undefined && query.scopeId === undefined) {
    return { scope: null, scopeId: null };
  }
  const scope = assertEnum(query.scope, SCOPE_TYPES, 'scope');
  const scopeId = assertUuid(query.scopeId, 'scopeId');
  return { scope, scopeId };
}

// Base query every activity aggregate starts from: messages joined to their
// channel, restricted to non-DM channels, then narrowed by scope. Only the
// `organization` scope needs a join out to workspaces (for organization_id) —
// `workspace`/`channel` scope filter directly on columns already in hand.
// No existence check on scopeId: an admin querying a scope that doesn't
// exist (or no longer does) simply gets zero rows back, the same "absent,
// not an error" shape this app's other aggregate-read endpoints already use
// (entities.js trending/experts) — a system admin has structural authority
// everywhere, so there is nothing here for existence-hiding to protect.
function baseActivityQuery({ scope, scopeId }) {
  let query = db('messages as m').join('channels as c', 'c.id', 'm.channel_id').whereNotNull('c.workspace_id');

  if (scope === 'workspace') {
    query = query.andWhere('c.workspace_id', scopeId);
  } else if (scope === 'channel') {
    query = query.andWhere('c.id', scopeId);
  } else if (scope === 'organization') {
    query = query.join('workspaces as w', 'w.id', 'c.workspace_id').andWhere('w.organization_id', scopeId);
  }
  return query;
}

// GET /api/admin/analytics/activity?scope=organization|workspace|channel&scopeId=&windowDays=&bucket=day|week
adminAnalyticsRouter.get('/activity', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const { scope, scopeId } = parseScope(req.query);
    const windowDays = parseWindowDays(req.query);
    const bucket =
      req.query.bucket !== undefined ? assertEnum(req.query.bucket, BUCKET_TYPES, 'bucket') : 'day';
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // date_trunc(bucket, ...) is computed once in a derived table and
    // grouped by its plain output column ("bucket") in the outer query,
    // rather than repeating a raw date_trunc(?, ...) expression in SELECT/
    // GROUP BY/ORDER BY directly — each repetition binds its own `?`
    // placeholder, and Postgres's GROUP BY column-matching is syntactic, not
    // value-aware, so three separately-bound (if identically-valued)
    // date_trunc(...) calls are three different expressions as far as
    // "must appear in the GROUP BY clause" is concerned.
    const scoped = baseActivityQuery({ scope, scopeId })
      .andWhere('m.created_at', '>=', since)
      .select(db.raw('date_trunc(?, m.created_at) as bucket', [bucket]), 'm.user_id as user_id')
      .as('scoped');

    const rows = await db
      .from(scoped)
      .groupBy('bucket')
      .orderBy('bucket')
      .select(
        'bucket',
        db.raw('count(*)::int as "messageCount"'),
        db.raw('count(distinct user_id)::int as "activeUserCount"'),
      );

    res.json({
      buckets: rows.map((r) => ({ bucket: r.bucket, messageCount: r.messageCount, activeUserCount: r.activeUserCount })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/dormant-channels?windowDays=
//
// Same "latest main-feed message, or channels.created_at if never
// messaged" live-computed pattern directMessages.js's own per-user DM
// dormancy already established (GET /api/direct-messages's LEFT JOIN
// LATERAL), applied globally with a single admin-supplied threshold instead
// of a per-user one. The cutoff is computed once in JS off the server
// clock and bound as a plain timestamptz parameter — the same convention
// directMessages.js's own resolveEffectiveArchiveDays/archiveCutoff already
// use, rather than doing interval arithmetic in SQL.
adminAnalyticsRouter.get('/dormant-channels', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const windowDays = parseWindowDays(req.query);
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const result = await db.raw(
      `SELECT c.id AS channel_id, c.name AS channel_name,
              c.workspace_id, w.name AS workspace_name,
              w.organization_id, o.name AS organization_name,
              COALESCE(lm.created_at, c.created_at) AS last_activity_at
       FROM channels c
       JOIN workspaces w ON w.id = c.workspace_id
       JOIN organizations o ON o.id = w.organization_id
       LEFT JOIN LATERAL (
         SELECT created_at
         FROM messages
         WHERE messages.channel_id = c.id AND messages.parent_message_id IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON true
       WHERE c.workspace_id IS NOT NULL
         AND COALESCE(lm.created_at, c.created_at) < ?::timestamptz
       ORDER BY COALESCE(lm.created_at, c.created_at) ASC`,
      [cutoff],
    );

    const now = Date.now();
    res.json(
      result.rows.map((row) => ({
        channelId: row.channel_id,
        channelName: row.channel_name,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        daysSinceActivity: Math.floor((now - new Date(row.last_activity_at).getTime()) / (24 * 60 * 60 * 1000)),
      })),
    );
  } catch (err) {
    next(err);
  }
});
