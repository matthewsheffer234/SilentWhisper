import { NotFoundError } from '../errors.js';

const NOTIFICATION_PREVIEW_CHARS = 180;

function toPreview(content) {
  if (!content) return '';
  return content.length > NOTIFICATION_PREVIEW_CHARS ? `${content.slice(0, NOTIFICATION_PREVIEW_CHARS - 3)}...` : content;
}

function mapNotification(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    senderUserId: row.mentioned_by_user_id,
    senderUsername: row.sender_username,
    workspaceName: row.workspace_name,
    channelName: row.channel_name,
    parentMessageId: row.parent_message_id,
    parentMessage: row.parent_message_id
      ? {
          id: row.parent_message_id,
          channelId: row.channel_id,
          userId: row.parent_user_id,
          username: row.parent_username,
          content: row.parent_content,
          parentMessageId: null,
          createdAt: row.parent_created_at,
        }
      : null,
    preview: toPreview(row.content),
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

// Shared by REST and WebSocket send paths. It deliberately accepts already
// resolved mentioned user ids from mentionService.js, so parsing/membership
// resolution stays in one place and this service only owns durable display
// state.
export async function createMentionNotifications(db, { mentionedUserIds, message, workspaceId, mentionedByUserId }) {
  if (!mentionedUserIds?.length) return [];

  const rows = mentionedUserIds.map((recipientUserId) => ({
    recipient_user_id: recipientUserId,
    message_id: message.id,
    channel_id: message.channelId,
    workspace_id: workspaceId,
    mentioned_by_user_id: mentionedByUserId,
  }));

  return db('mention_notifications')
    .insert(rows)
    .onConflict(['recipient_user_id', 'message_id'])
    .ignore()
    .returning(['id', 'recipient_user_id']);
}

function baseVisibleNotificationsQuery(db, userId) {
  return db('mention_notifications')
    .join('messages', 'messages.id', 'mention_notifications.message_id')
    .join('channels', 'channels.id', 'mention_notifications.channel_id')
    .leftJoin('workspaces', 'workspaces.id', 'mention_notifications.workspace_id')
    .leftJoin({ parent_messages: 'messages' }, 'parent_messages.id', 'messages.parent_message_id')
    .leftJoin({ parent_users: 'users' }, 'parent_users.id', 'parent_messages.user_id')
    .join('channel_members', function joinChannelMembership() {
      this.on('channel_members.channel_id', '=', 'mention_notifications.channel_id').andOnVal(
        'channel_members.user_id',
        '=',
        userId,
      );
    })
    .leftJoin({ sender: 'users' }, 'sender.id', 'mention_notifications.mentioned_by_user_id')
    .where('mention_notifications.recipient_user_id', userId)
    .whereNull('mention_notifications.dismissed_at');
}

export async function listMentionNotifications(db, userId, { limit, before, unreadOnly } = {}) {
  let query = baseVisibleNotificationsQuery(db, userId);
  if (before) {
    query = query.where('mention_notifications.created_at', '<', before);
  }
  if (unreadOnly) {
    query = query.whereNull('mention_notifications.read_at');
  }

  const rows = await query
    .orderBy('mention_notifications.created_at', 'desc')
    .limit(limit)
    .select(
      'mention_notifications.id',
      'mention_notifications.message_id',
      'mention_notifications.channel_id',
      'mention_notifications.workspace_id',
      'mention_notifications.mentioned_by_user_id',
      'mention_notifications.created_at',
      'mention_notifications.read_at',
      'mention_notifications.dismissed_at',
      'messages.content',
      'messages.parent_message_id',
      'parent_messages.user_id as parent_user_id',
      'parent_users.username as parent_username',
      'parent_messages.content as parent_content',
      'parent_messages.created_at as parent_created_at',
      'sender.username as sender_username',
      'workspaces.name as workspace_name',
      'channels.name as channel_name',
    );

  return rows.map(mapNotification);
}

export async function getMentionSummary(db, userId) {
  const totalRow = await baseVisibleNotificationsQuery(db, userId)
    .whereNull('mention_notifications.read_at')
    .first(db.raw('COUNT(*)::int AS count'));

  const byWorkspaceRows = await baseVisibleNotificationsQuery(db, userId)
    .whereNull('mention_notifications.read_at')
    .groupBy('mention_notifications.workspace_id')
    .select('mention_notifications.workspace_id')
    .select(db.raw('COUNT(*)::int AS count'));

  const byChannelRows = await baseVisibleNotificationsQuery(db, userId)
    .whereNull('mention_notifications.read_at')
    .groupBy('mention_notifications.channel_id')
    .select('mention_notifications.channel_id')
    .select(db.raw('COUNT(*)::int AS count'));

  return {
    unreadCount: totalRow?.count ?? 0,
    byWorkspace: byWorkspaceRows.map((r) => ({ workspaceId: r.workspace_id, unreadCount: r.count })),
    byChannel: byChannelRows.map((r) => ({ channelId: r.channel_id, unreadCount: r.count })),
  };
}

export async function markMentionNotificationRead(db, userId, notificationId) {
  const existing = await baseVisibleNotificationsQuery(db, userId)
    .where('mention_notifications.id', notificationId)
    .first('mention_notifications.id');
  if (!existing) {
    throw new NotFoundError('Notification not found');
  }

  const [row] = await db('mention_notifications')
    .where({ id: notificationId, recipient_user_id: userId })
    .update({ read_at: db.fn.now() })
    .returning(['id', 'read_at']);
  return { id: row.id, readAt: row.read_at };
}

export async function markAllMentionNotificationsRead(db, userId) {
  const visibleIds = await baseVisibleNotificationsQuery(db, userId)
    .whereNull('mention_notifications.read_at')
    .select('mention_notifications.id');
  if (visibleIds.length === 0) {
    return { updated: 0 };
  }

  const ids = visibleIds.map((r) => r.id);
  const rows = await db('mention_notifications')
    .whereIn('id', ids)
    .where({ recipient_user_id: userId })
    .update({ read_at: db.fn.now() })
    .returning('id');
  return { updated: rows.length };
}
