import { ForbiddenError, NotFoundError, ConflictError } from '../errors.js';
import { PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS, ORG_ROLE_PERMISSIONS } from './permissions.js';

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

  // managers_can_archive (FEATURE_REQUEST.md entry 1, slice 4): the schema
  // column has existed since slice 1 but was never read until now. OWNER's
  // archive access is unconditional; a MANAGER's is delegated per-workspace
  // via POST /:workspaceId/settings (WORKSPACE_MANAGE_SETTINGS, owner-only).
  if (role === 'MANAGER' && permission === PERMISSIONS.WORKSPACE_ARCHIVE) {
    const workspace = await db('workspaces').where({ id: workspaceId }).first('managers_can_archive');
    if (!workspace?.managers_can_archive) {
      throw new ForbiddenError('Archiving is not delegated to managers for this workspace');
    }
  }

  return { role, viaSystemAdminOverride: false };
}

// A system admin can administer any workspace's structure — channels,
// channel membership, and (per requireWorkspacePermission above) settings/
// members/archive/ownership — without being a workspace_members row
// themselves, the same "bypass the resource's own role map, still 404 on a
// resource that doesn't exist" shape requireWorkspacePermission already
// established. Deliberately does NOT extend to message content: nothing in
// messages.js gets this bypass, so an admin who administers a private
// workspace this way still cannot read a single message in it unless they
// take some further, explicit, auditable action that makes them a genuine
// channel_members row (e.g. creating a channel, or adding themselves via
// POST .../channels/:channelId/members) — the same way it would for anyone
// else. This is a deliberate, narrower scope than requireWorkspacePermission's
// existing bypass, not an oversight: "manage the workspace" and "read every
// private conversation in it" are different privileges, and only the first
// is being granted here.
// Genuine membership is checked before the system-admin override, not after:
// a system admin who is also a real workspace_members row (e.g. because they
// created the workspace themselves, which auto-enrolls the creator as OWNER
// regardless of admin status) must be treated as the genuine member they
// are, not as a non-member exercising the structural override. Checking
// isSystemAdminUser first returned viaSystemAdminOverride: true
// unconditionally for every system admin, including in their own workspace —
// which meant POST .../channels skipped the channel_members insert (Finding 1
// above) even for an admin creating a channel in a workspace they genuinely
// own, so the composer never left its "Joining channel…" state.
export async function requireWorkspaceMemberOrSystemAdmin(db, userId, workspaceId) {
  const role = await getWorkspaceRole(db, userId, workspaceId);
  if (role) {
    return { role, viaSystemAdminOverride: false };
  }

  if (await isSystemAdminUser(db, userId)) {
    const workspace = await db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }
    return { role: null, viaSystemAdminOverride: true };
  }

  throw new NotFoundError('Workspace not found');
}

// System-wide surfaces (AI settings, audit dashboard) have no per-workspace
// scoping of their own. This used to also grant access to anyone who held
// OWNER/MANAGER in at least one workspace (a deliberate, temporary widening
// from when no is_system_admin account existed yet — see
// scripts/grant-system-admin.mjs) — that OR-fallback let any user
// self-escalate to global audit-log access and global AI-settings control
// simply by creating a workspace (Security.md, 2026-07-15, HIGH: "Self-
// Service Workspace Ownership Grants Global Audit/AI Administration").
// Account provisioning now exists, so the fallback is removed: these
// surfaces are is_system_admin-only, full stop.
export async function requireSystemAdmin(db, userId) {
  if (!(await isSystemAdminUser(db, userId))) {
    throw new ForbiddenError('System admin privileges required');
  }
  return { viaSystemAdminOverride: true };
}

export async function getOrgRole(db, userId, organizationId) {
  const row = await db('organization_members')
    .where({ organization_id: organizationId, user_id: userId })
    .first('org_role');
  return row ? row.org_role : null;
}

// Not-a-member -> 404, identical reasoning to requireWorkspaceMember.
export async function requireOrgMember(db, userId, organizationId) {
  const role = await getOrgRole(db, userId, organizationId);
  if (!role) {
    throw new NotFoundError('Organization not found');
  }
  return role;
}

// Mirrors requireWorkspacePermission exactly: a system admin bypasses the
// org's own role map entirely, but still gets a 404 for a nonexistent org
// (the override grants privilege, not omniscience about resources that
// don't exist) — not-a-member -> 404, member-but-insufficient-role -> 403.
export async function requireOrgPermission(db, userId, organizationId, permission) {
  if (await isSystemAdminUser(db, userId)) {
    const org = await db('organizations').where({ id: organizationId }).first();
    if (!org) {
      throw new NotFoundError('Organization not found');
    }
    return { role: null, viaSystemAdminOverride: true };
  }

  const role = await requireOrgMember(db, userId, organizationId);
  const granted = (ORG_ROLE_PERMISSIONS[role] ?? []).includes(permission);
  if (!granted) {
    throw new ForbiddenError('Insufficient organization privileges');
  }
  return { role, viaSystemAdminOverride: false };
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

// Organization lifecycle management (system admin only, see organizations.js).
// Structurally identical to requireWorkspaceNotArchived — called after the
// caller's org permission/existence has already been established.
export async function requireOrgNotArchived(db, organizationId) {
  const org = await db('organizations').where({ id: organizationId }).first('archived_at');
  if (org?.archived_at) {
    throw new ConflictError('This organization is archived');
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

// Structural-management counterpart to requireChannelMember, mirroring
// requireWorkspaceMemberOrSystemAdmin above: a system admin can view or grow
// a channel's membership roster without being a member themselves, still
// 404ing for a channel that doesn't exist. Returns the same bare channel row
// requireChannelMember does (not an object), so call sites can swap the
// function name in place with no other changes. Deliberately not used by
// messages.js — this never grants message-content read access on its own.
export async function requireChannelMemberOrSystemAdmin(db, userId, channelId) {
  if (await isSystemAdminUser(db, userId)) {
    const channel = await getChannel(db, channelId);
    if (!channel) {
      throw new NotFoundError('Channel not found');
    }
    return channel;
  }
  return requireChannelMember(db, userId, channelId);
}
