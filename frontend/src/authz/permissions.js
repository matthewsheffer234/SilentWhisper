// Mirrors backend/src/authz/permissions.js and membershipService.js's
// requireWorkspacePermission/requireOrgPermission/requireSystemAdmin.
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
  // AI_SETTINGS_MANAGE/AUDIT_VIEW deliberately removed (Security.md,
  // 2026-07-15, HIGH finding): those two global surfaces are gated on
  // is_system_admin only now, not a role-map permission — see
  // ChatShell.jsx's isSystemAdmin usage for AdminPanel's AI Settings/Audit
  // Log rows.
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
// locally from the POST response instead of a refetch).
export function hasOrgManagementAccess(isSystemAdmin, role) {
  return isSystemAdmin || hasOrgPermission(role, PERMISSIONS.ORG_MANAGE_MEMBERS);
}

// Gates the Admin hub's workspace-scoped "Manage Users" entry point only —
// UserManagementPanel is per-workspace (requireWorkspacePermission
// server-side), unlike AI Settings/Audit Log, which are global surfaces now
// gated directly on isSystemAdmin (Security.md, 2026-07-15, HIGH finding:
// the old shared "system admin OR OWNER/MANAGER of any workspace" check let
// self-service workspace ownership grant access to those two global
// surfaces as well — see requireSystemAdmin's backend doc comment). A
// system admin with no workspace memberships of their own still sees this
// entry point so they aren't locked out of workspace user administration.
export function hasAnyWorkspaceAdminAccess(isSystemAdmin, workspaces) {
  if (isSystemAdmin) return true;
  return workspaces.some((ws) => ws.role === 'OWNER' || ws.role === 'MANAGER');
}
