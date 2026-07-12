import { ForbiddenError, NotFoundError } from '../errors.js';

// The one shared authorization module used by every REST handler now, and
// by WebSocket room-join/reconnect handling starting Phase 3 (PROJECT_PLAN.md
// Section 3, Authorization Model: "Centralize membership checks ... in one
// shared backend module used by both REST handlers and WebSocket event
// handlers, so the rule is written once and cannot drift between the two
// transports.") Every function here takes `db` explicitly (a knex instance
// or an active transaction) rather than importing the singleton, so it works
// identically inside a transaction or against the plain pool.

export async function getWorkspaceRole(db, userId, workspaceId) {
  const row = await db('workspace_members')
    .where({ workspace_id: workspaceId, user_id: userId })
    .first('system_role');
  return row ? row.system_role : null;
}

// Not-a-member -> 404, not 403 (Section 3: a private resource's existence
// isn't confirmed to someone who can't access it).
export async function requireWorkspaceMember(db, userId, workspaceId) {
  const role = await getWorkspaceRole(db, userId, workspaceId);
  if (!role) {
    throw new NotFoundError('Workspace not found');
  }
  return role;
}

// Membership already established (existence known) -> insufficient privilege
// is 403, not 404.
export async function requireWorkspaceAdmin(db, userId, workspaceId) {
  const role = await requireWorkspaceMember(db, userId, workspaceId);
  if (role !== 'ADMIN') {
    throw new ForbiddenError('Workspace admin privileges required');
  }
}

export async function getChannel(db, channelId) {
  return db('channels').where({ id: channelId }).first();
}

export async function isChannelMember(db, userId, channelId) {
  const row = await db('channel_members')
    .where({ channel_id: channelId, user_id: userId })
    .first();
  return Boolean(row);
}

// Returns the channel row on success. Non-members get 404 for the same
// reason as requireWorkspaceMember — including when the channel simply
// doesn't exist, so the two cases are indistinguishable from the outside.
export async function requireChannelMember(db, userId, channelId) {
  const channel = await getChannel(db, channelId);
  if (!channel) {
    throw new NotFoundError('Channel not found');
  }
  const member = await isChannelMember(db, userId, channelId);
  if (!member) {
    throw new NotFoundError('Channel not found');
  }
  return channel;
}
