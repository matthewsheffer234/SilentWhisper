import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { assertUuid } from '../validation.js';
import { ValidationError, NotFoundError } from '../errors.js';

export const directMessagesRouter = Router();

directMessagesRouter.use(requireAuth);

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
