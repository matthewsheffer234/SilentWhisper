import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid } from '../validation.js';
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
directMessagesRouter.get('/', async (req, res, next) => {
  try {
    const channelRows = await db('channels as c')
      .join('channel_members as cm', 'cm.channel_id', 'c.id')
      .where('cm.user_id', req.user.id)
      .whereIn('c.type', ['DIRECT', 'GROUP_DM'])
      .select('c.id', 'c.type', 'c.created_at');

    if (channelRows.length === 0) {
      res.json([]);
      return;
    }
    const channelIds = channelRows.map((c) => c.id);

    // Every other member (never the caller themselves) — a one-to-one DIRECT
    // channel's `members` array is always exactly one person; GROUP_DM's has
    // every other participant, matching the design's "member names, not
    // 'Group Direct Message'" requirement.
    const memberRows = await db('channel_members as cm')
      .join('users', 'users.id', 'cm.user_id')
      .whereIn('cm.channel_id', channelIds)
      .whereNot('users.id', req.user.id)
      .orderBy('users.username', 'asc')
      .select('cm.channel_id as channelId', 'users.id as userId', 'users.username', 'users.display_name as displayName');

    const membersByChannel = new Map();
    for (const row of memberRows) {
      const list = membersByChannel.get(row.channelId) ?? [];
      list.push({ userId: row.userId, username: row.username, displayName: row.displayName });
      membersByChannel.set(row.channelId, list);
    }

    // Last main-feed message per channel (thread replies excluded — a
    // digest of "what's the most recent thing in this conversation" cares
    // about the top-level feed, same scope messages.js's own channel-history
    // endpoint defaults to). DISTINCT ON is Postgres-specific and not a
    // first-class knex builder concept, so this goes through db.raw the same
    // way embeddingWorker.js's claimBatch already does for its own
    // Postgres-specific query.
    const lastMessageResult = await db.raw(
      `SELECT DISTINCT ON (channel_id) channel_id, content, created_at, user_id
       FROM messages
       WHERE channel_id = ANY(?) AND parent_message_id IS NULL
       ORDER BY channel_id, created_at DESC`,
      [channelIds],
    );
    const lastMessageByChannel = new Map(
      lastMessageResult.rows.map((r) => [
        r.channel_id,
        { content: r.content, createdAt: r.created_at, userId: r.user_id },
      ]),
    );

    const result = channelRows
      .map((c) => ({
        id: c.id,
        type: c.type,
        members: membersByChannel.get(c.id) ?? [],
        lastMessage: lastMessageByChannel.get(c.id) ?? null,
        createdAt: c.created_at,
      }))
      // Most recent activity first — falls back to the channel's own
      // created_at for a DM that's never had a message sent in it yet.
      .sort((a, b) => {
        const aTime = new Date(a.lastMessage?.createdAt ?? a.createdAt).getTime();
        const bTime = new Date(b.lastMessage?.createdAt ?? b.createdAt).getTime();
        return bTime - aTime;
      });

    res.json(result);
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
