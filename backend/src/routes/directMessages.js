import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid, MAX_GROUP_DM_MEMBERS, parseOffsetPagination } from '../validation.js';
import { ValidationError, NotFoundError } from '../errors.js';

export const directMessagesRouter = Router();

directMessagesRouter.use(requireAuth);

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section): the first "list my DMs" read endpoint — POST / above only ever
// created or reopened a single DIRECT channel; nothing returned the set of
// DIRECT/GROUP_DM channels a caller belongs to, since no DM-browsing UI
// existed yet. Both types share one list (rather than two separate
// endpoints under directMessages/group-direct-messages) because the sidebar
// renders them as a single "Direct Messages" section — the frontend
// shouldn't have to issue two requests and merge them itself. Membership
// itself is the only authorization check: DIRECT/GROUP_DM channels have no
// workspace_id to defer to (Section 4), so "is a member of this channel" is
// the complete story, same as every other channel-membership-gated route.
//
// FEATURE_REQUEST.md entry 2: offset-paginated ({directMessages, total,
// limit, offset}), following GET /admin/users' precedent. The "most recent
// activity first" ordering has to happen in SQL now, not a post-fetch JS
// .sort() over every one of the caller's DM channels, or LIMIT/OFFSET would
// cut the page before the sort had a chance to run. A LATERAL join (like the
// existing DISTINCT ON query it replaces, this is Postgres-specific and
// goes through db.raw) finds each channel's own latest main-feed message
// (thread replies excluded, same scope as before) so ORDER BY can reference
// it directly, falling back to the channel's own created_at for a DM that's
// never had a message sent in it yet.
directMessagesRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = parseOffsetPagination(req.query);

    const countRow = await db('channels as c')
      .join('channel_members as cm', 'cm.channel_id', 'c.id')
      .where('cm.user_id', req.user.id)
      .whereIn('c.type', ['DIRECT', 'GROUP_DM'])
      .count('c.id as count')
      .first();
    const total = Number(countRow.count);

    if (total === 0) {
      res.json({ directMessages: [], total, limit, offset });
      return;
    }

    const pageResult = await db.raw(
      `SELECT c.id, c.type, c.created_at,
              lm.content AS last_content, lm.created_at AS last_created_at, lm.user_id AS last_user_id
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
       LEFT JOIN LATERAL (
         SELECT content, created_at, user_id
         FROM messages
         WHERE messages.channel_id = c.id AND messages.parent_message_id IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON true
       WHERE c.type IN ('DIRECT', 'GROUP_DM')
       ORDER BY COALESCE(lm.created_at, c.created_at) DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset],
    );
    const channelRows = pageResult.rows;
    const channelIds = channelRows.map((c) => c.id);

    // Every other member (never the caller themselves) — a one-to-one DIRECT
    // channel's `members` array is always exactly one person; GROUP_DM's has
    // every other participant, matching the design's "member names, not
    // 'Group Direct Message'" requirement.
    const memberRows = channelIds.length
      ? await db('channel_members as cm')
          .join('users', 'users.id', 'cm.user_id')
          .whereIn('cm.channel_id', channelIds)
          .whereNot('users.id', req.user.id)
          .orderBy('users.username', 'asc')
          .select(
            'cm.channel_id as channelId',
            'users.id as userId',
            'users.username',
            'users.display_name as displayName',
          )
      : [];

    const membersByChannel = new Map();
    for (const row of memberRows) {
      const list = membersByChannel.get(row.channelId) ?? [];
      list.push({ userId: row.userId, username: row.username, displayName: row.displayName });
      membersByChannel.set(row.channelId, list);
    }

    const directMessages = channelRows.map((c) => ({
      id: c.id,
      type: c.type,
      members: membersByChannel.get(c.id) ?? [],
      lastMessage: c.last_created_at
        ? { content: c.last_content, createdAt: c.last_created_at, userId: c.last_user_id }
        : null,
      createdAt: c.created_at,
    }));

    res.json({ directMessages, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

async function findExistingDirectChannel(trx, userA, userB) {
  const row = await trx('channels as c')
    .where('c.type', 'DIRECT')
    .whereNull('c.workspace_id')
    .whereExists(function existsA() {
      this.select(1).from('channel_members as cm1').whereRaw('cm1.channel_id = c.id').andWhere('cm1.user_id', userA);
    })
    .whereExists(function existsB() {
      this.select(1).from('channel_members as cm2').whereRaw('cm2.channel_id = c.id').andWhere('cm2.user_id', userB);
    })
    .andWhere(trx.raw('(select count(*) from channel_members cm3 where cm3.channel_id = c.id) = 2'))
    .first('c.id');
  return row?.id ?? null;
}

// DIRECT and GROUP_DM channels have a NULL workspace_id (channels.workspace_id
// has no NOT NULL constraint — PROJECT_PLAN.md Section 4) — DMs aren't scoped
// to any particular workspace, matching the Feature Requirements list
// ("Users can create 1-to-1 direct messages" / "ad-hoc group direct
// messages") without tying them to a workspace context.
directMessagesRouter.post('/', async (req, res, next) => {
  try {
    const targetUserId = assertUuid(req.body?.targetUserId, 'targetUserId');
    if (targetUserId === req.user.id) {
      throw new ValidationError('Cannot start a direct message with yourself');
    }

    const targetUser = await db('users').where({ id: targetUserId }).first('id');
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    const result = await db.transaction(async (trx) => {
      // Two concurrent POSTs for the same pair (e.g. both users opening
      // each other's profile from a shared roster at once) can otherwise
      // both pass the "no existing channel" check under READ COMMITTED and
      // create two DIRECT channels for the same pair — this endpoint's own
      // "creates or reuses" contract silently failing at exactly the
      // concurrency level this app targets
      // (docs/reviews/security-performance-review-2026-07-19.md Finding 9).
      // Locked on the sorted pair so the two possible call orderings
      // (a->b vs b->a) contend for the same key, same
      // pg_advisory_xact_lock(hashtext(...)) pattern auditService.js's hash
      // chain append uses for its own race-prone path.
      const [loId, hiId] = [req.user.id, targetUserId].sort();
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`dm:${loId}:${hiId}`]);

      const existingId = await findExistingDirectChannel(trx, req.user.id, targetUserId);
      if (existingId) {
        return { id: existingId, created: false };
      }
      const [channel] = await trx('channels')
        .insert({ workspace_id: null, name: 'Direct Message', type: 'DIRECT' })
        .returning(['id']);
      await trx('channel_members').insert([
        { channel_id: channel.id, user_id: req.user.id },
        { channel_id: channel.id, user_id: targetUserId },
      ]);
      return { id: channel.id, created: true };
    });

    if (result.created) {
      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: result.id,
        payload: { action: 'create_direct_message', withUserId: targetUserId },
      });
    }

    res.status(result.created ? 201 : 200).json({ id: result.id, type: 'DIRECT' });
  } catch (err) {
    next(err);
  }
});

const groupDirectMessagesRouter = Router();
groupDirectMessagesRouter.use(requireAuth);

groupDirectMessagesRouter.post('/', async (req, res, next) => {
  try {
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : null;
    if (!memberIds || memberIds.length === 0) {
      throw new ValidationError('memberIds must be a non-empty array');
    }
    // Checked before per-element UUID validation/DB lookup — a large
    // malformed array shouldn't even reach those.
    if (memberIds.length > MAX_GROUP_DM_MEMBERS) {
      throw new ValidationError(`memberIds must include at most ${MAX_GROUP_DM_MEMBERS} users`);
    }
    const uniqueTargetIds = [...new Set(memberIds.map((id) => assertUuid(id, 'memberIds[]')))].filter(
      (id) => id !== req.user.id,
    );
    if (uniqueTargetIds.length === 0) {
      throw new ValidationError('memberIds must include at least one other user');
    }

    const existingUsers = await db('users').whereIn('id', uniqueTargetIds).select('id');
    if (existingUsers.length !== uniqueTargetIds.length) {
      throw new ValidationError('One or more memberIds do not exist');
    }

    const channel = await db.transaction(async (trx) => {
      const [ch] = await trx('channels')
        .insert({ workspace_id: null, name: 'Group Direct Message', type: 'GROUP_DM' })
        .returning(['id']);
      await trx('channel_members').insert([
        { channel_id: ch.id, user_id: req.user.id },
        ...uniqueTargetIds.map((id) => ({ channel_id: ch.id, user_id: id })),
      ]);
      return ch;
    });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
      targetResource: channel.id,
      payload: { action: 'create_group_dm', memberIds: uniqueTargetIds },
    });

    res.status(201).json({ id: channel.id, type: 'GROUP_DM' });
  } catch (err) {
    next(err);
  }
});

export { groupDirectMessagesRouter };
