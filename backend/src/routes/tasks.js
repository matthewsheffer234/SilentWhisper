import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireWorkspaceMember } from '../authz/membershipService.js';
import { config } from '../config.js';
import { assertUuid, assertBoundedInt, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../validation.js';
import { ValidationError } from '../errors.js';
import { parseTasks } from '../services/taskParser.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

// A deployment can narrow the default window per-request; this is just a
// sanity cap on how far back a single dashboard request may ever reach —
// not admin-editable, env-only like TASK_DASHBOARD_WINDOW_DAYS itself.
const MAX_TASK_DASHBOARD_WINDOW_DAYS = 365;

// LIKE candidates only — never trusted as proof of a well-formed task line
// on their own. `[ ]`/`[x]`/`[X]` covers every mark buildTaskLineRegex
// recognizes as "checked"/"unchecked" (services/taskParser.js); anything
// that merely contains one of these substrings but isn't actually a
// checkbox line (e.g. inside a code-ish aside) is filtered out for real by
// parseTasks() below, after the DB has already narrowed the candidate set.
function whereLikelyHasTaskLine(query) {
  return query.andWhere(function whereTaskLike() {
    this.where('m.content', 'like', '%- [ ]%').orWhere('m.content', 'like', '%- [x]%').orWhere('m.content', 'like', '%- [X]%');
  });
}

function parseDashboardQuery(query) {
  const windowDays =
    query.windowDays !== undefined
      ? assertBoundedInt(query.windowDays, { min: 1, max: MAX_TASK_DASHBOARD_WINDOW_DAYS }, 'windowDays')
      : config.tasks.dashboardWindowDays;

  const limit =
    query.limit !== undefined ? assertBoundedInt(query.limit, { min: 1, max: MAX_PAGE_LIMIT }, 'limit') : DEFAULT_PAGE_LIMIT;

  let cursor = null;
  if (query.cursor !== undefined) {
    cursor = new Date(query.cursor);
    if (Number.isNaN(cursor.getTime())) {
      throw new ValidationError('cursor must be a valid ISO timestamp');
    }
  }

  return { windowDays, limit, cursor };
}

// FEATURE_REQUEST.md entry 3: a live projection of channel content, not a
// second system of record — every fetch/broadcast recomputes task rows
// straight from messages.content via parseTasks(), so there is nothing here
// that can drift from what a channel view itself would render.
//
// Bounded like the already-shipped cross-channel "Catch Me Up" digest
// (workspaceDigestService.js): a rolling window
// (TASK_DASHBOARD_WINDOW_DAYS, default 30) via messages.created_at, not an
// unbounded LIKE '%...%' scan across a workspace's entire history (Section
// 2, Scalability Target). The live channel_members join is what keeps a
// task from a channel the caller has since lost access to out of the
// dashboard — same stale-private-channel-access concern the mention
// notifications panel and the digest already close for their own queries.
// DMs/group DMs are out of scope by construction, not by an extra check:
// they carry no workspace_id (identical precedent to entity linking
// skipping them, entityService.js), so `c.workspace_id = :workspaceId`
// already excludes them.
tasksRouter.get('/workspaces/:workspaceId/tasks', async (req, res, next) => {
  try {
    const workspaceId = assertUuid(req.params.workspaceId, 'workspaceId');
    await requireWorkspaceMember(db, req.user.id, workspaceId);
    const { windowDays, limit, cursor } = parseDashboardQuery(req.query);

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    let query = db('messages as m')
      .join('channels as c', 'c.id', 'm.channel_id')
      // Only channels the caller is currently a member of are ever
      // candidates — a private channel the caller isn't in contributes zero
      // rows, not an error (Section 3's existence-hiding convention, same
      // shape as workspaceDigestService.js's own membership join).
      .join('channel_members as cm', function joinMembership() {
        this.on('cm.channel_id', '=', 'c.id').andOnVal('cm.user_id', '=', req.user.id);
      })
      .join('users as u', 'u.id', 'm.user_id')
      .where('c.workspace_id', workspaceId)
      .where('m.created_at', '>', since);
    query = whereLikelyHasTaskLine(query);
    if (cursor) {
      query = query.where('m.created_at', '<', cursor);
    }

    const rows = await query
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .select(
        'm.id as message_id',
        'm.channel_id',
        'c.name as channel_name',
        'm.content',
        'm.created_at',
        'u.username',
        'u.display_name',
      );

    // The SQL above only narrows candidates by a LIKE substring match; the
    // real tokenization (and the response's actual {index, checked, text,
    // owner} shape) always comes from parseTasks() run server-side over
    // each candidate row's real content, never from trusting the substring
    // match itself as proof of a well-formed task line.
    const tasks = [];
    for (const row of rows) {
      for (const task of parseTasks(row.content)) {
        tasks.push({
          messageId: row.message_id,
          channelId: row.channel_id,
          channelName: row.channel_name,
          taskIndex: task.index,
          checked: task.checked,
          text: task.text,
          owner: task.owner,
          messageCreatedAt: row.created_at,
          authorUsername: row.username,
          authorDisplayName: row.display_name,
        });
      }
    }

    res.json({
      tasks,
      windowDays,
      // Present only when the page was full — the same "there might be
      // more, here's where to resume" shape as messages.js's own `before`
      // cursor. rows.length (message count), not tasks.length (task-row
      // count), is what determines whether another page of *messages*
      // might exist.
      nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null,
    });
  } catch (err) {
    next(err);
  }
});
