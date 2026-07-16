import { assertMessageContent, assertUuid } from '../validation.js';
import { ValidationError } from '../errors.js';

// Shared by the REST route (routes/messages.js) and the WebSocket message
// handler (ws/server.js) so the two transports can never drift on
// validation or insert logic — the same principle Section 3 requires for
// authorization checks, applied here to message creation itself.
export async function createMessage(db, { channelId, userId, username, displayName, content, parentMessageId }) {
  const validatedContent = assertMessageContent(content);

  let validatedParentId = null;
  if (parentMessageId !== undefined && parentMessageId !== null) {
    validatedParentId = assertUuid(parentMessageId, 'parentMessageId');
    const parent = await db('messages').where({ id: validatedParentId, channel_id: channelId }).first('id');
    if (!parent) {
      throw new ValidationError('parentMessageId must reference a message in the same channel');
    }
  }

  const [message] = await db('messages')
    .insert({
      channel_id: channelId,
      user_id: userId,
      content: validatedContent,
      parent_message_id: validatedParentId,
    })
    .returning(['id', 'channel_id', 'user_id', 'content', 'parent_message_id', 'created_at']);

  return {
    id: message.id,
    channelId: message.channel_id,
    userId: message.user_id,
    // Passed in by the caller (both call sites already have it from the
    // authenticated identity — JWT claims via req.user/ws.username) rather
    // than looked up here, so sending a message never costs an extra query
    // just to know the sender's own username/display name.
    username,
    displayName,
    content: message.content,
    parentMessageId: message.parent_message_id,
    createdAt: message.created_at,
  };
}
