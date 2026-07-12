import { ForbiddenError, NotFoundError, ConflictError } from '../errors.js';

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

// `system_role` (ADMIN/MEMBER) is scoped per-workspace (Section 4) — there
// is no separate global-admin table. The AI settings surface in Phase 4
// ("admin-only settings surface" per Section 6) is a single, workspace-
// agnostic set of app_settings rows, so it's gated on "is an ADMIN of at
// least one workspace" rather than any particular workspace's admin, which
// is the closest fit the existing schema supports without adding a new
// global-role concept for one settings screen.
export async function requireAnyWorkspaceAdmin(db, userId) {
  const row = await db('workspace_members').where({ user_id: userId, system_role: 'ADMIN' }).first('workspace_id');
  if (!row) {
    throw new ForbiddenError('Workspace admin privileges required');
  }
}

// FEATURE_REQUEST.md, workspace archive/unarchive: archiving is authorized
// if the caller is the workspace's owner_id *or* holds system_role=ADMIN —
// broader than requireWorkspaceAdmin alone, since an owner who isn't
// separately an ADMIN member (an edge case the schema otherwise allows)
// should still be able to archive their own workspace. Existence-hiding
// applies the same way as requireWorkspaceMember: a caller who is neither
// the owner nor any kind of member gets 404, not 403.
export async function requireWorkspaceOwnerOrAdmin(db, userId, workspaceId) {
  const workspace = await db('workspaces').where({ id: workspaceId }).first();
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }
  if (workspace.owner_id === userId) {
    return workspace;
  }
  const role = await getWorkspaceRole(db, userId, workspaceId);
  if (!role) {
    throw new NotFoundError('Workspace not found');
  }
  if (role !== 'ADMIN') {
    throw new ForbiddenError('Workspace owner or admin privileges required');
  }
  return workspace;
}

// Centralized so the "an archived workspace can't be written to" rule is
// written once and can't drift across the REST/WS write paths that need it
// (Section 3's anti-drift principle, already established for membership
// checks). Called *after* the caller's membership/admin authorization
// already succeeded — the caller not being authorized at all is a 404/403
// concern this function doesn't re-adjudicate; an archived workspace is a
// 409 (the action is unavailable given the resource's current state, not
// that the caller lacks permission for it).
export async function requireWorkspaceNotArchived(db, workspaceId) {
  const workspace = await db('workspaces').where({ id: workspaceId }).first('archived_at');
  if (workspace?.archived_at) {
    throw new ConflictError('This workspace is archived');
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
