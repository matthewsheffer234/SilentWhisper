import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember } from '../authz/membershipService.js';
import { assertUuid, assertMessageContent, parsePagination } from '../validation.js';
import { ValidationError } from '../errors.js';

export const messagesRouter = Router();

messagesRouter.use(requireAuth);

// Paginated by timestamp cursor (`before`), not offset, matching
// idx_messages_channel_date's (channel_id, created_at DESC) — never an
// unbounded scan regardless of channel size (Section 2, Scalability Target).
// Returns newest-first. Pass ?parentMessageId=<uuid> to fetch a thread's
// replies instead of the main channel feed.
messagesRouter.get('/channels/:channelId/messages', async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireChannelMember(db, req.user.id, channelId);
    const { limit, before } = parsePagination(req.query);

    let query = db('messages').where({ channel_id: channelId });
    if (req.query.parentMessageId !== undefined) {
      query = query.where({ parent_message_id: assertUuid(req.query.parentMessageId, 'parentMessageId') });
    } else {
      query = query.whereNull('parent_message_id');
    }
    if (before) {
      query = query.where('created_at', '<', before);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at');

    res.json(
      rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        userId: r.user_id,
        content: r.content,
        parentMessageId: r.parent_message_id,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

messagesRouter.post('/channels/:channelId/messages', async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireChannelMember(db, req.user.id, channelId);

    const content = assertMessageContent(req.body?.content);
    let parentMessageId = null;
    if (req.body?.parentMessageId !== undefined && req.body?.parentMessageId !== null) {
      parentMessageId = assertUuid(req.body.parentMessageId, 'parentMessageId');
      const parent = await db('messages').where({ id: parentMessageId, channel_id: channelId }).first('id');
      if (!parent) {
        throw new ValidationError('parentMessageId must reference a message in the same channel');
      }
    }

    const [message] = await db('messages')
      .insert({ channel_id: channelId, user_id: req.user.id, content, parent_message_id: parentMessageId })
      .returning(['id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at']);

    res.status(201).json({
      id: message.id,
      channelId: message.channel_id,
      userId: message.user_id,
      content: message.content,
      parentMessageId: message.parent_message_id,
      createdAt: message.created_at,
    });
  } catch (err) {
    next(err);
  }
});
