import { ForbiddenError, NotFoundError, ConflictError } from '../errors.js';
import { WORKSPACE_ROLE_PERMISSIONS } from './permissions.js';

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

export async function isSystemAdminUser(db, userId) {
  const row = await db('users').where({ id: userId }).first('is_system_admin');
  return Boolean(row?.is_system_admin);
}

// Permission-based replacement for requireWorkspaceAdmin/
// requireWorkspaceOwnerOrAdmin (FEATURE_REQUEST.md entry 1, slice 1). A
// system admin (users.is_system_admin, migration 0011) bypasses the
// workspace's own role map entirely, but still gets a 404 for a nonexistent
// workspace — the override grants privilege, not omniscience about resources
// that don't exist. Otherwise: not-a-member -> 404 (requireWorkspaceMember's
// existing existence-hiding), member-but-insufficient-role -> 403.
//
// This single function now covers what used to be three separate ones
// (requireWorkspaceAdmin, requireAnyWorkspaceAdmin's workspace-scoped sibling
// requireWorkspaceOwnerOrAdmin). One deliberate behavior change worth noting
// here rather than leaving implicit: today's unarchive gate
// (requireWorkspaceAdmin, ADMIN-only) excluded an owner who wasn't
// separately an ADMIN member — an edge case the schema allowed. Migration
// 0012 guarantees every owner now holds OWNER, and OWNER holds
// WORKSPACE_ARCHIVE, so every owner can now always both archive and
// unarchive their own workspace. This closes a pre-existing inconsistency;
// it does not open up unarchive to anyone who couldn't already archive.
export async function requireWorkspacePermission(db, userId, workspaceId, permission) {
  if (await isSystemAdminUser(db, userId)) {
    const workspace = await db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }
    return { role: null, viaSystemAdminOverride: true };
  }

  const role = await requireWorkspaceMember(db, userId, workspaceId);
  const granted = (WORKSPACE_ROLE_PERMISSIONS[role] ?? []).includes(permission);
  if (!granted) {
    throw new ForbiddenError('Insufficient workspace privileges');
  }
  return { role, viaSystemAdminOverride: false };
}

// System-wide surfaces (AI settings, audit dashboard) have no per-workspace
// scoping of their own, so — same reasoning the old requireAnyWorkspaceAdmin
// comment gave — access is granted to a system admin OR anyone who holds
// OWNER/MANAGER in at least one workspace. The OR-fallback is a deliberate,
// temporary widening: tightening this to is_system_admin-only would lock out
// every current workspace admin immediately, since no is_system_admin
// account is provisioned by this slice (see scripts/grant-system-admin.mjs).
// Remove the fallback only once account provisioning (a later slice) makes
// that safe — not part of this slice's scope.
export async function requireSystemPermission(db, userId, _permission) {
  if (await isSystemAdminUser(db, userId)) {
    return { viaSystemAdminOverride: true };
  }
  const row = await db('workspace_members')
    .where({ user_id: userId })
    .whereIn('system_role', ['OWNER', 'MANAGER'])
    .first('workspace_id');
  if (!row) {
    throw new ForbiddenError('Workspace admin privileges required');
  }
  return { viaSystemAdminOverride: false };
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
