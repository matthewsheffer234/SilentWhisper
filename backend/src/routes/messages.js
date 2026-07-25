import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireChannelMember, requireWorkspaceNotArchived } from '../authz/membershipService.js';
import {
  assertUuid,
  assertBoundedInt,
  assertBoolean,
  assertMessageContent,
  parsePagination,
  MAX_USERNAME_LENGTH,
  MAX_MESSAGE_LENGTH,
} from '../validation.js';
import { createMessage } from '../services/messageService.js';
import { enqueueMessageSideEffectJobs } from '../services/messageSideEffectsQueue.js';
import { setTaskChecked } from '../services/taskParser.js';
import { enqueueEmbeddingJob } from '../search/embeddingQueue.js';
import { broadcastToRoom } from '../ws/connectionRegistry.js';
import { isMessageRateLimited } from '../ws/rateLimiter.js';
import { memberSearchLimiter, taskToggleLimiter, messageEditLimiter } from '../auth/rateLimit.js';
import { appendAuditEvent } from '../audit/auditService.js';
import { RateLimitedError, ValidationError, ForbiddenError, NotFoundError } from '../errors.js';

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
        'messages.edited_at',
        // Replies never have their own children (flat one-level threading,
        // 0004_communication_and_content.js), so this is always 0 when
        // fetching a thread's own replies — no branching needed between the
        // two query modes above. Backed by idx_messages_threading.
        db.raw(
          '(select count(*) from messages as replies where replies.parent_message_id = messages.id)::int as reply_count',
        ),
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
        editedAt: r.edited_at,
        replyCount: Number(r.reply_count),
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

    // Side effects of message creation, not part of it — mention-notification
    // writing and [[Entity]] linking used to run inline here (FEATURE_REQUEST.md
    // "hot path splitting" entry); both now go through a durable job queue
    // processed by workers/messageSideEffectsWorker.js, so message-send
    // latency no longer grows with mention/entity count. Same
    // "side effect, not part of message creation" pattern as the embedding
    // enqueue below, which predates this and was left as-is.
    await enqueueMessageSideEffectJobs(db, { messageId: message.id, workspaceId: channel.workspace_id });

    // Enqueues async embedding work for semantic search (FEATURE_REQUEST.md
    // entry 1). Failure-tolerant by design: see enqueueEmbeddingJob's own
    // doc comment.
    await enqueueEmbeddingJob(db, message.id);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// A task line is at minimum "- [ ]\n" (6 chars), so MAX_MESSAGE_LENGTH
// (validation.js) bounds how many task lines a single message could ever
// contain — used here purely to reject a nonsensical taskIndex before it
// ever reaches setTaskChecked, not because any real message approaches this
// many lines.
const MAX_TASK_INDEX = Math.floor(MAX_MESSAGE_LENGTH / 6);

// FEATURE_REQUEST.md entry 3: inline Markdown checkbox tasks
// (`- [ ] text [owner:: @user]`, services/taskParser.js). This is the first
// intentional post-create mutation of messages.content — messages are
// otherwise immutable once sent, so taskIndex is stable for a message's
// entire life except through this endpoint itself (which never changes line
// count or order, only the single checkbox character). Body is an explicit
// target state (`{checked: true|false}`), deliberately not an implied
// "swap the bracket" toggle — two people clicking the same checkbox near-
// simultaneously both converge on the same end state instead of racing to
// flip it twice back to where it started.
messagesRouter.patch(
  '/channels/:channelId/messages/:messageId/tasks/:taskIndex',
  taskToggleLimiter,
  async (req, res, next) => {
    try {
      const channelId = assertUuid(req.params.channelId, 'channelId');
      const messageId = assertUuid(req.params.messageId, 'messageId');
      const taskIndex = assertBoundedInt(req.params.taskIndex, { min: 0, max: MAX_TASK_INDEX }, 'taskIndex');
      const channel = await requireChannelMember(db, req.user.id, channelId);
      await requireWorkspaceNotArchived(db, channel.workspace_id);
      const checked = assertBoolean(req.body?.checked, 'checked');

      // Row-locked so two concurrent toggles of the same message can't both
      // parse stale content and then overwrite each other — the explicit
      // target state above prevents double-flip behavior, but the lock is
      // still the clearer correctness guard once two writers are racing
      // (same "never rely on default isolation" instinct as the audit
      // chain's own advisory lock, Section 3).
      const updated = await db.transaction(async (trx) => {
        const message = await trx('messages')
          .where({ id: messageId })
          .forUpdate()
          .first('id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at');
        // Confirms the two path params actually belong together — the same
        // "prove channelId and messageId belong to each other" check this
        // codebase already established as its pattern for the cross-
        // workspace channel-member-injection fix. Existence-hiding: a
        // missing message and a real message in a different channel 404
        // identically.
        if (!message || message.channel_id !== channelId) {
          throw new NotFoundError('Message not found');
        }

        const newContent = setTaskChecked(message.content, taskIndex, checked);
        if (newContent === null) {
          throw new NotFoundError('Task not found');
        }

        await trx('messages').where({ id: messageId }).update({ content: newContent });
        const author = await trx('users').where({ id: message.user_id }).first('username', 'display_name');

        return {
          id: message.id,
          channelId: message.channel_id,
          userId: message.user_id,
          username: author.username,
          displayName: author.display_name,
          content: newContent,
          parentMessageId: message.parent_message_id,
          createdAt: message.created_at,
        };
      });

      broadcastToRoom(channelId, { type: 'message_updated', message: updated });

      await appendAuditEvent(db, {
        actorId: req.user.id,
        actorIp: req.ip,
        actionType: 'MESSAGE_TASK_TOGGLED',
        targetResource: messageId,
        // ids/counts only, never message content (Section 6).
        payload: { channelId, taskIndex, checked },
      });

      // Derived-data side effects of the content change, decided explicitly
      // rather than left implicit (this is the first post-create mutation
      // of messages.content, so "messages are immutable" can no longer be
      // assumed everywhere):
      // - Embeddings: re-enqueue so semantic search doesn't keep serving the
      //   pre-toggle vector. Cheap, and keeps the "message content changed,
      //   embedding follows" invariant intact. enqueueEmbeddingJob's own
      //   onConflict('message_id').ignore() means this only actually
      //   inserts a fresh job if the original one already completed and was
      //   deleted — the normal case by the time anyone toggles a checkbox;
      //   if it's still pending, that job will simply read the now-updated
      //   content whenever it runs.
      await enqueueEmbeddingJob(db, messageId);
      // - Entity links: left untouched. Toggling only ever changes the
      //   single checkbox character, so it cannot add or remove a
      //   [[Entity]] token in the description — there is nothing for
      //   message_entities to recompute.
      // - Mentions/notifications: deliberately not re-run. A checkbox state
      //   change should not notify @mentions/the task's owner again; the
      //   audit event and WS broadcast above are enough.

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// FEATURE_REQUEST.md entry 3: editing a sent message, with a permanent,
// auditable revision history. Author-only — no manager/owner override.
// Unlike the task-toggle route above (deliberately any channel member,
// since a task can be assigned to someone else), rewriting someone else's
// actual words has no such justification and no existing precedent grants
// one; a moderator/redaction capability is a separate, future concern, not
// folded in here. Also unlike task-toggle, only within a fixed window of
// the message's original send time (config.messages.editWindowMinutes,
// env-overridable, default 15) — editing again does not extend the window,
// since it's measured from created_at, not from the most recent edit.
messagesRouter.patch('/channels/:channelId/messages/:messageId', messageEditLimiter, async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    const messageId = assertUuid(req.params.messageId, 'messageId');
    const channel = await requireChannelMember(db, req.user.id, channelId);
    await requireWorkspaceNotArchived(db, channel.workspace_id);
    const content = assertMessageContent(req.body?.content);

    // Row-locked so two concurrent edits of the same message can't both
    // read stale content and silently drop one edit's history row — same
    // instinct as the task-toggle route's own lock above.
    const { updated, previousContentLength } = await db.transaction(async (trx) => {
      const message = await trx('messages')
        .where({ id: messageId })
        .forUpdate()
        .first('id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at');
      // Existence-hiding: a missing message and a real message in a
      // different channel 404 identically (same cross-workspace-channel-
      // injection-fix pattern as task-toggle above).
      if (!message || message.channel_id !== channelId) {
        throw new NotFoundError('Message not found');
      }
      if (message.user_id !== req.user.id) {
        // The caller already legitimately sees this message via the
        // channel-membership check above — hiding its existence with a 404
        // here would be wrong; existence-hiding is for callers who aren't
        // authorized to see the resource at all, not for an authorized
        // viewer who simply isn't allowed to change it.
        throw new ForbiddenError('Only the author can edit this message');
      }
      const windowMs = config.messages.editWindowMinutes * 60 * 1000;
      if (Date.now() - new Date(message.created_at).getTime() > windowMs) {
        throw new ValidationError(`Messages can only be edited within ${config.messages.editWindowMinutes} minutes of sending`);
      }

      // Captures the message exactly as it was before this edit — the
      // first such row for a given message is therefore the message
      // exactly as originally sent. No UPDATE/DELETE grant exists on this
      // table (migration 0027): a historical snapshot must never change
      // once written.
      await trx('message_edits').insert({ message_id: messageId, content: message.content, edited_by: req.user.id });

      const [row] = await trx('messages')
        .where({ id: messageId })
        .update({ content, edited_at: trx.fn.now() })
        .returning(['id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at', 'edited_at']);
      const author = await trx('users').where({ id: message.user_id }).first('username', 'display_name');

      return {
        previousContentLength: message.content.length,
        updated: {
          id: row.id,
          channelId: row.channel_id,
          userId: row.user_id,
          username: author.username,
          displayName: author.display_name,
          content: row.content,
          parentMessageId: row.parent_message_id,
          createdAt: row.created_at,
          editedAt: row.edited_at,
        },
      };
    });

    broadcastToRoom(channelId, { type: 'message_updated', message: updated });

    await appendAuditEvent(db, {
      actorId: req.user.id,
      actorIp: req.ip,
      actionType: 'MESSAGE_EDITED',
      targetResource: messageId,
      // Lengths only, never the old or new text (Section 6) — matching
      // this codebase's absolute "never log raw content" convention.
      payload: { channelId, contentLengthBefore: previousContentLength, contentLengthAfter: updated.content.length },
    });

    // Derived-data side effects, decided explicitly (same instinct as the
    // task-toggle route's own comment) — but unlike a checkbox toggle, a
    // real content edit CAN add or remove a [[Entity]] token or an
    // @mention, so both need to actually re-run here, not be left alone:
    // - Embeddings: re-enqueue so semantic search/sentiment reflect the
    //   edited text, identical mechanism to task-toggle.
    await enqueueEmbeddingJob(db, messageId);
    // - Entity links: re-enqueued the same way message creation does.
    //   linkMessageEntities (services/entityService.js) now reconciles
    //   message_entities against the freshly-extracted set rather than
    //   only appending, so a token removed by this edit is actually
    //   cleared, not left stale.
    // - Mentions/notifications: re-enqueued the same way too. A newly
    //   added @mention gets a real notification, the same legitimate
    //   expectation as if it had been there from the start;
    //   mention_notifications' existing per-(recipient,message) uniqueness
    //   constraint means a mention present before and after the edit is
    //   never re-notified. A mention *removed* by the edit is deliberately
    //   left exactly as it was — there is no "un-notify" mechanism
    //   anywhere in this codebase, and the person genuinely was mentioned
    //   in a message that existed with that text at some point.
    await enqueueMessageSideEffectJobs(db, { messageId, workspaceId: channel.workspace_id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// FEATURE_REQUEST.md entry 3: the revision history behind the "(edited)"
// tag. Gated the same as reading the message itself (channel membership) —
// a member who can already see the current content isn't being shown
// anything new by seeing what it used to say, so this is deliberately not
// admin-only. Newest-first (most recent prior version first), matching
// this app's general "most recent first" convention for history/activity
// lists elsewhere.
messagesRouter.get('/channels/:channelId/messages/:messageId/edits', async (req, res, next) => {
  try {
    const channelId = assertUuid(req.params.channelId, 'channelId');
    const messageId = assertUuid(req.params.messageId, 'messageId');
    await requireChannelMember(db, req.user.id, channelId);

    const message = await db('messages').where({ id: messageId }).first('id', 'channel_id');
    if (!message || message.channel_id !== channelId) {
      throw new NotFoundError('Message not found');
    }

    const rows = await db('message_edits as me')
      .leftJoin('users as u', 'u.id', 'me.edited_by')
      .where('me.message_id', messageId)
      .orderBy('me.edited_at', 'desc')
      .select('me.id', 'me.content', 'me.edited_at', 'u.username', 'u.display_name');

    res.json(
      rows.map((r) => ({
        id: r.id,
        content: r.content,
        editedAt: r.edited_at,
        username: r.username,
        displayName: r.display_name,
      })),
    );
  } catch (err) {
    next(err);
  }
});
