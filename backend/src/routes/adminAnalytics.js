import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireSystemAdmin } from '../authz/membershipService.js';
import { adminAnalyticsLimiter } from '../auth/rateLimit.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, assertEnum, assertBoundedInt } from '../validation.js';

// FEATURE_REQUEST.md's Admin Analytics Dashboard entries (activity/
// engagement, collaboration structure, aggregate sentiment). Every query in
// this file reads only messages.created_at/channel_id/user_id/parent_message_id,
// channel_members, and (sentiment-trend only) message_sentiment_scores —
// never messages.content — and is scoped to non-DM channels by construction
// (channels.workspace_id IS NOT NULL), never DM/GROUP_DM (workspace_id NULL,
// per directMessages.js's own existing comment). This is a deliberate
// boundary, not an accident of the join shape: aggregating how much a
// person talks in their DMs is a sharper privacy concern than a per-channel
// route existing at all, especially given the shipped ephemeral-DM/
// auto-archive entry exists specifically to shrink DM footprint and
// visibility.
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

function parseBucket(query) {
  return query.bucket !== undefined ? assertEnum(query.bucket, BUCKET_TYPES, 'bucket') : 'day';
}

// scope/scopeId are a matched pair — omitting both reports across every
// organization (authorized because a system admin already has structural
// authority everywhere and this never reads message content); giving one
// without the other is a 400, not a silent fallback to "everything."
// `allowedScopes` varies per route: /activity and interaction-trend allow
// organization/workspace/channel; membership-graph allows only
// organization/workspace (a channel-scoped membership overlap is a single
// channel's own roster, not a cross-channel bridge signal); sentiment-trend
// additionally allows `user`.
function parseScope(query, allowedScopes) {
  if (query.scope === undefined && query.scopeId === undefined) {
    return { scope: null, scopeId: null };
  }
  const scope = assertEnum(query.scope, allowedScopes, 'scope');
  const scopeId = assertUuid(query.scopeId, 'scopeId');
  return { scope, scopeId };
}

// Base query every messages-rooted aggregate starts from: messages joined
// to their channel, restricted to non-DM channels, then narrowed by scope.
// Only the `organization` scope needs a join out to workspaces (for
// organization_id) — `workspace`/`channel`/`user` scope filter directly on
// columns already in hand. No existence check on scopeId: an admin querying
// a scope that doesn't exist (or no longer does) simply gets zero rows
// back, the same "absent, not an error" shape this app's other
// aggregate-read endpoints already use (entities.js trending/experts) — a
// system admin has structural authority everywhere, so there is nothing
// here for existence-hiding to protect.
function baseMessagesQuery({ scope, scopeId }) {
  let query = db('messages as m').join('channels as c', 'c.id', 'm.channel_id').whereNotNull('c.workspace_id');

  if (scope === 'workspace') {
    query = query.andWhere('c.workspace_id', scopeId);
  } else if (scope === 'channel') {
    query = query.andWhere('c.id', scopeId);
  } else if (scope === 'organization') {
    query = query.join('workspaces as w', 'w.id', 'c.workspace_id').andWhere('w.organization_id', scopeId);
  } else if (scope === 'user') {
    query = query.andWhere('m.user_id', scopeId);
  }
  return query;
}

// GET /api/admin/analytics/activity?scope=organization|workspace|channel&scopeId=&windowDays=&bucket=day|week
adminAnalyticsRouter.get('/activity', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const { scope, scopeId } = parseScope(req.query, SCOPE_TYPES);
    const windowDays = parseWindowDays(req.query);
    const bucket = parseBucket(req.query);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // date_trunc(bucket, ...) is computed once in a derived table and
    // grouped by its plain output column ("bucket") in the outer query,
    // rather than repeating a raw date_trunc(?, ...) expression in SELECT/
    // GROUP BY/ORDER BY directly — each repetition binds its own `?`
    // placeholder, and Postgres's GROUP BY column-matching is syntactic, not
    // value-aware, so three separately-bound (if identically-valued)
    // date_trunc(...) calls are three different expressions as far as
    // "must appear in the GROUP BY clause" is concerned.
    const scoped = baseMessagesQuery({ scope, scopeId })
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

const MEMBERSHIP_GRAPH_SCOPE_TYPES = ['organization', 'workspace'];

function parseMinSharedChannels(query) {
  return query.minSharedChannels !== undefined
    ? assertBoundedInt(query.minSharedChannels, { min: 0, max: 100_000 }, 'minSharedChannels')
    : config.adminAnalytics.minSharedChannels;
}

// GET /api/admin/analytics/collaboration/membership-graph?scope=organization|workspace&scopeId=&minSharedChannels=
//
// Structural snapshot, zero `messages` access: which pairs of users share
// enough channel memberships to plausibly bridge otherwise-siloed
// conversations. `channel_members` has no `joined_at`/`created_at` column
// (migration 0003_layout_and_hierarchy.js's channel_members is just
// (channel_id, user_id)), so this is a current snapshot, not a trend —
// a known limitation, not silently only showing half of what "over time"
// would imply. `minSharedChannels` suppresses pairs at or below the
// threshold *before* they're returned (HAVING, not a post-filter) — the
// same "absent, not zeroed" anti-inference convention entry 2's trending
// endpoint already established: a pair sharing exactly the threshold count
// or fewer channels is common and not a meaningful "bridge" signal.
adminAnalyticsRouter.get('/collaboration/membership-graph', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const { scope, scopeId } = parseScope(req.query, MEMBERSHIP_GRAPH_SCOPE_TYPES);
    const minSharedChannels = parseMinSharedChannels(req.query);

    let query = db('channel_members as cm1')
      // The `<` (not `=`) avoids double-counting each pair in both
      // directions and excludes self-pairs, matching the design's own
      // `cm1.user_id < cm2.user_id` self-join shape exactly.
      .join('channel_members as cm2', function joinPair() {
        this.on('cm1.channel_id', '=', 'cm2.channel_id').andOn('cm1.user_id', '<', 'cm2.user_id');
      })
      .join('channels as c', 'c.id', 'cm1.channel_id')
      .whereNotNull('c.workspace_id');

    if (scope === 'workspace') {
      query = query.andWhere('c.workspace_id', scopeId);
    } else if (scope === 'organization') {
      query = query.join('workspaces as w', 'w.id', 'c.workspace_id').andWhere('w.organization_id', scopeId);
    }

    const rows = await query
      .groupBy('cm1.user_id', 'cm2.user_id')
      .havingRaw('count(distinct cm1.channel_id) > ?', [minSharedChannels])
      .select(
        'cm1.user_id as user_a',
        'cm2.user_id as user_b',
        db.raw('count(distinct cm1.channel_id)::int as "sharedChannels"'),
      );

    if (rows.length === 0) {
      res.json({ nodes: [], edges: [] });
      return;
    }

    const userIds = [...new Set(rows.flatMap((r) => [r.user_a, r.user_b]))];
    const users = await db('users').whereIn('id', userIds).select('id', 'username', 'display_name');
    const usersById = new Map(users.map((u) => [u.id, u]));

    res.json({
      nodes: userIds.map((id) => ({
        userId: id,
        username: usersById.get(id)?.username ?? null,
        displayName: usersById.get(id)?.display_name ?? null,
      })),
      edges: rows.map((r) => ({ userA: r.user_a, userB: r.user_b, sharedChannels: r.sharedChannels })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/collaboration/interaction-trend?scope=organization|workspace|channel&scopeId=&windowDays=&bucket=day|week
//
// Reply-based, time-bucketed, still metadata only: how much cross-person
// interaction is happening, trended over time — never a per-pair-per-bucket
// edge list (that shape grows unboundedly with user count × bucket count
// for little added insight over the snapshot graph above; the *structure*
// of who-talks-to-whom stays in membership-graph). A reply to one's own
// message is excluded — that's not an interaction between two people, and
// counting it would inflate both replyCount and distinctPairCount with
// something that isn't collaboration.
adminAnalyticsRouter.get('/collaboration/interaction-trend', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const { scope, scopeId } = parseScope(req.query, SCOPE_TYPES);
    const windowDays = parseWindowDays(req.query);
    const bucket = parseBucket(req.query);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // Same derived-table technique as /activity: date_trunc(bucket, ...) is
    // computed once and grouped by its plain output column downstream.
    // user_a/user_b are normalized via LEAST/GREATEST (UUID supports btree
    // comparison, so this works directly on the column type) so a pair is
    // counted once regardless of who replied to whom; distinctPairCount
    // counts distinct normalized pairs via a text-concatenated key rather
    // than a row-constructor DISTINCT, for a simpler, more portable query.
    const scoped = baseMessagesQuery({ scope, scopeId })
      .join('messages as pm', 'pm.id', 'm.parent_message_id')
      .whereNotNull('m.parent_message_id')
      .whereRaw('pm.user_id != m.user_id')
      .andWhere('m.created_at', '>=', since)
      .select(
        db.raw('date_trunc(?, m.created_at) as bucket', [bucket]),
        db.raw('LEAST(m.user_id, pm.user_id) as user_a'),
        db.raw('GREATEST(m.user_id, pm.user_id) as user_b'),
      )
      .as('scoped');

    const rows = await db
      .from(scoped)
      .groupBy('bucket')
      .orderBy('bucket')
      .select(
        'bucket',
        db.raw('count(*)::int as "replyCount"'),
        db.raw(`count(distinct (user_a::text || ':' || user_b::text))::int as "distinctPairCount"`),
      );

    res.json({
      buckets: rows.map((r) => ({ bucket: r.bucket, replyCount: r.replyCount, distinctPairCount: r.distinctPairCount })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/sentiment-trend?scope=organization|workspace|channel|user&scopeId=&windowDays=&bucket=day|week
//
// Reuses the embedding search/embeddingWorker.js already computes for
// semantic search — see search/sentimentService.js for the score itself.
// Buckets with fewer than config.sentiment.minBucketMessages scored
// messages are dropped from the response entirely (HAVING, not returned
// with a wide-variance average), the same anti-overinterpretation control
// membership-graph's minSharedChannels applies to pair suppression.
adminAnalyticsRouter.get('/sentiment-trend', async (req, res, next) => {
  try {
    await requireSystemAdmin(db, req.user.id);

    const { scope, scopeId } = parseScope(req.query, [...SCOPE_TYPES, 'user']);
    const windowDays = parseWindowDays(req.query);
    const bucket = parseBucket(req.query);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const scoped = baseMessagesQuery({ scope, scopeId })
      .join('message_sentiment_scores as mss', 'mss.message_id', 'm.id')
      .andWhere('m.created_at', '>=', since)
      .select(db.raw('date_trunc(?, m.created_at) as bucket', [bucket]), 'mss.score as score')
      .as('scoped');

    const rows = await db
      .from(scoped)
      .groupBy('bucket')
      .havingRaw('count(*) >= ?', [config.sentiment.minBucketMessages])
      .orderBy('bucket')
      .select('bucket', db.raw('avg(score)::float as "avgScore"'), db.raw('count(*)::int as "messageCount"'));

    // `scope=user` is individual tone-monitoring — the closest this feature
    // gets to surveillance of a specific person — so visibility into it is
    // logged, unlike the organization/workspace/channel scopes, which stay
    // unaudited (pure aggregate reads, no content, matching the Activity/
    // Collaboration entries' precedent).
    if (scope === 'user') {
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'AI_SENTIMENT_TREND_VIEWED',
        targetResource: scopeId,
        payload: { targetUserId: scopeId, windowDays, bucket },
      });
    }

    res.json({
      buckets: rows.map((r) => ({ bucket: r.bucket, avgScore: r.avgScore, messageCount: r.messageCount })),
    });
  } catch (err) {
    next(err);
  }
});
