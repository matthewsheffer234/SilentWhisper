import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember, requireWorkspaceNotArchived } from '../authz/membershipService.js';
import { assertUuid, assertBoundedInt, parsePagination, MAX_USERNAME_LENGTH } from '../validation.js';
import { createMessage } from '../services/messageService.js';
import { extractMentionedUserIds } from '../services/mentionService.js';
import { createMentionNotifications } from '../services/mentionNotificationService.js';
import { enqueueEmbeddingJob } from '../search/embeddingQueue.js';
import { broadcastToRoom, sendToUser } from '../ws/connectionRegistry.js';
import { isMessageRateLimited } from '../ws/rateLimiter.js';
import { memberSearchLimiter } from '../auth/rateLimit.js';
import { RateLimitedError, ValidationError } from '../errors.js';

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
        'users.display_name',
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
        displayName: r.display_name,
        content: r.content,
        parentMessageId: r.parent_message_id,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

const MEMBER_SEARCH_DEFAULT_LIMIT = 8;
const MEMBER_SEARCH_MAX_LIMIT = 8;

// FEATURE_REQUEST.md's @mention autocomplete entry. No "who is in this
// channel" read endpoint existed anywhere before this — every prior
// channel_members/workspace_members touch point was a POST (invite, join,
// add-to-channel) or an internal-only membership check. Same existence-
// hiding gate as message history: a non-member or nonexistent channel 404s,
// per Section 3's "must never be joinable, listable, or readable by
// non-members, including via search."
messagesRouter.get('/channels/:channelId/members', memberSearchLimiter, async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    await requireChannelMember(db, req.user.id, channelId);

    const limit =
      req.query.limit !== undefined
        ? assertBoundedInt(req.query.limit, { min: 1, max: MEMBER_SEARCH_MAX_LIMIT }, 'limit')
        : MEMBER_SEARCH_DEFAULT_LIMIT;

    // `q` is optional — empty/omitted returns the first page of members
    // alphabetically, the expected combobox behavior right after typing a
    // bare `@`. Bounded to MAX_USERNAME_LENGTH if present, but not required
    // to match the full USERNAME_RE pattern — a partial prefix mid-word
    // (e.g. "ma") is a valid, expected query, not a malformed username.
    let q = '';
    if (req.query.q !== undefined) {
      q = String(req.query.q);
      if (q.length > MAX_USERNAME_LENGTH) {
        throw new ValidationError(`q must be at most ${MAX_USERNAME_LENGTH} characters`);
      }
    }

    let query = db('channel_members')
      .join('users', 'users.id', 'channel_members.user_id')
      .where('channel_members.channel_id', channelId)
      // Self-mentions never notify (mentionService.js's excludeUserId does
      // the same at send time) — suggesting yourself would just waste a
      // dropdown row; typing your own username by hand still works
      // identically, it's just never suggested.
      .whereNot('users.id', req.user.id);
    if (q) {
      query = query.andWhere('users.username', 'ilike', `${q}%`);
    }

    const rows = await query
      .orderBy('users.username', 'asc')
      .limit(limit)
      .select('users.id', 'users.username', 'users.display_name as displayName');

    res.json(rows);
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
    const channel = await requireChannelMember(db, req.user.id, channelId);
    // Sends into an archived workspace's channels are blocked — the same
    // "cannot be updated" rule the workspace/channel write routes in
    // workspaces.js already enforce, reached here via the channel's own
    // workspace_id since this route is keyed by channel, not workspace.
    await requireWorkspaceNotArchived(db, channel.workspace_id);

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
      displayName: req.user.displayName,
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
    let notificationRows = [];
    try {
      notificationRows = await createMentionNotifications(db, {
        mentionedUserIds,
        message,
        workspaceId: channel.workspace_id,
        mentionedByUserId: req.user.id,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to create mention notifications:', err);
    }
    const notificationIdsByRecipient = new Map(notificationRows.map((r) => [r.recipient_user_id, r.id]));
    for (const mentionedUserId of mentionedUserIds) {
      sendToUser(mentionedUserId, {
        type: 'mention',
        message,
        channelId,
        workspaceId: channel.workspace_id,
        mentionedBy: req.user.username,
        mentionedByDisplayName: req.user.displayName,
        notificationId: notificationIdsByRecipient.get(mentionedUserId) ?? null,
      });
    }

    // Same "side effect, not part of message creation" pattern as mentions
    // above — enqueues async embedding work for semantic search
    // (FEATURE_REQUEST.md entry 1). Failure-tolerant by design: see
    // enqueueEmbeddingJob's own doc comment.
    await enqueueEmbeddingJob(db, message.id);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});
