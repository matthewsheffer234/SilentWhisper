import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember } from '../authz/membershipService.js';
import { assertUuid, parsePagination } from '../validation.js';
import { createMessage } from '../services/messageService.js';
import { extractMentionedUserIds } from '../services/mentionService.js';
import { broadcastToRoom, sendToUser } from '../ws/connectionRegistry.js';
import { isMessageRateLimited } from '../ws/rateLimiter.js';
import { RateLimitedError } from '../errors.js';

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

    // Every filter/order column is qualified with `messages.` — both
    // messages and users have a created_at column, and an unqualified
    // reference is ambiguous the moment the join below is added (Postgres
    // rejects the whole query, it doesn't guess).
    let query = db('messages').where({ 'messages.channel_id': channelId });
    if (req.query.parentMessageId !== undefined) {
      query = query.where({ 'messages.parent_message_id': assertUuid(req.query.parentMessageId, 'parentMessageId') });
    } else {
      query = query.whereNull('messages.parent_message_id');
    }
    if (before) {
      query = query.where('messages.created_at', '<', before);
    }

    const rows = await query
      .join('users', 'users.id', 'messages.user_id')
      .orderBy('messages.created_at', 'desc')
      .limit(limit)
      .select(
        'messages.id',
        'messages.channel_id',
        'messages.user_id',
        'users.username',
        'messages.content',
        'messages.parent_message_id',
        'messages.created_at',
      );

    res.json(
      rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        userId: r.user_id,
        username: r.username,
        content: r.content,
        parentMessageId: r.parent_message_id,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Sends over REST also broadcast to WebSocket-joined clients (ws/server.js
// handles sends that arrive over the socket itself) — the same
// messageService.createMessage call backs both transports, and both notify
// the same room registry, so a message sent by one client's REST call still
// appears in real time for everyone else connected via WS.
messagesRouter.post('/channels/:channelId/messages', async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireChannelMember(db, req.user.id, channelId);

    // Section 3, Rate Limiting & Abuse Prevention: "Rate-limit message sends
    // per user/connection so a single client cannot flood a channel..." —
    // shares one counter with the WebSocket `message` frame path
    // (ws/server.js's handleMessage) rather than each transport getting its
    // own independent budget, since the actual requirement is a per-user
    // send rate, not a per-transport one; sending via REST must not be a way
    // to get a second, uncounted allowance on top of WS.
    if (isMessageRateLimited(req.user.id)) {
      throw new RateLimitedError('Too many messages — slow down');
    }

    const message = await createMessage(db, {
      channelId,
      userId: req.user.id,
      username: req.user.username,
      content: req.body?.content,
      parentMessageId: req.body?.parentMessageId,
    });

    broadcastToRoom(channelId, { type: 'message_created', message });

    // A side effect of message creation, not part of it — mirrors
    // messageService.js's own header comment on why mention parsing lives
    // in a sibling service rather than inside createMessage.
    const mentionedUserIds = await extractMentionedUserIds(db, {
      content: message.content,
      channelId,
      excludeUserId: req.user.id,
    });
    for (const mentionedUserId of mentionedUserIds) {
      sendToUser(mentionedUserId, { type: 'mention', message, channelId, mentionedBy: req.user.username });
    }

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});
