// Mirrors backend/src/authz/permissions.js and membershipService.js's
// requireWorkspacePermission/requireOrgPermission/requireSystemPermission.
// No shared-code mechanism exists between frontend and backend in this repo
// (no monorepo/workspaces config) — kept in sync by hand, reviewed together
// in the same commit. This file only ever controls what the UI *offers*;
// every permission is re-enforced server-side regardless (PROJECT_PLAN.md
// Section 3), so drift here is a UX bug, never a security one.

export const PERMISSIONS = {
  WORKSPACE_MANAGE_MEMBERS: 'WORKSPACE_MANAGE_MEMBERS',
  // New, slice 4: any action that assigns/revokes/removes a MANAGER-tier
  // membership. OWNER holds both this and WORKSPACE_MANAGE_MEMBERS; MANAGER
  // holds only WORKSPACE_MANAGE_MEMBERS.
  WORKSPACE_MANAGE_MANAGERS: 'WORKSPACE_MANAGE_MANAGERS',
  WORKSPACE_ARCHIVE: 'WORKSPACE_ARCHIVE',
  // New, slice 4: OWNER only.
  WORKSPACE_TRANSFER_OWNERSHIP: 'WORKSPACE_TRANSFER_OWNERSHIP',
  // New, slice 4: OWNER only.
  WORKSPACE_CHANGE_VISIBILITY: 'WORKSPACE_CHANGE_VISIBILITY',
  // New, slice 4: OWNER only.
  WORKSPACE_MANAGE_SETTINGS: 'WORKSPACE_MANAGE_SETTINGS',
  AI_SETTINGS_MANAGE: 'AI_SETTINGS_MANAGE',
  AUDIT_VIEW: 'AUDIT_VIEW',
  ORG_INVITE: 'ORG_INVITE',
  ORG_MANAGE_MEMBERS: 'ORG_MANAGE_MEMBERS',
};

export const WORKSPACE_ROLE_PERMISSIONS = {
  OWNER: [
    PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
    PERMISSIONS.WORKSPACE_MANAGE_MANAGERS,
    PERMISSIONS.WORKSPACE_ARCHIVE,
    PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP,
    PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY,
    PERMISSIONS.WORKSPACE_MANAGE_SETTINGS,
  ],
  // Slice 4 tightening: a MANAGER no longer holds everything OWNER does.
  // WORKSPACE_ARCHIVE is further narrowed server-side by managers_can_archive
  // (not expressible here — this file only controls what the UI *offers*).
  MANAGER: [PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE],
  MEMBER: [],
};

export const ORG_ROLE_PERMISSIONS = {
  ORG_ADMIN: [PERMISSIONS.ORG_INVITE, PERMISSIONS.ORG_MANAGE_MEMBERS],
  ORG_MEMBER: [],
};

export function hasPermission(role, permission) {
  return (WORKSPACE_ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function hasOrgPermission(role, permission) {
  return (ORG_ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

// A system admin bypasses an org's own role map entirely server-side
// (requireOrgPermission's override), for any org that exists — but
// GET /organizations reports role: null for every row in the system-admin
// "sees all orgs" branch, even for orgs the admin is an actual member of
// (a real gap found while wiring the org switcher: without this OR-
// fallback, a system admin could never open org management for any org
// except one they'd just created in the same session, whose role is known
// locally from the POST response instead of a refetch). Mirrors
// hasSystemPermission's OR-fallback shape.
export function hasOrgManagementAccess(isSystemAdmin, role) {
  return isSystemAdmin || hasOrgPermission(role, PERMISSIONS.ORG_MANAGE_MEMBERS);
}

// Mirrors requireSystemPermission's OR-fallback exactly: system admin OR
// OWNER/MANAGER of at least one workspace. `permission` is unused today on
// the backend too (kept for signature parity, so a future backend
// tightening doesn't require an untraceable frontend rewrite).
export function hasSystemPermission(isSystemAdmin, workspaces, _permission) {
  if (isSystemAdmin) return true;
  return workspaces.some((ws) => ws.role === 'OWNER' || ws.role === 'MANAGER');
}
