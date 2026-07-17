// Permission catalog for the enterprise authorization model
// (FEATURE_REQUEST.md entry 1). Slice 4 adds the remaining
// workspace-scoped permissions (managers-tier split, ownership transfer,
// visibility change, settings) — see SLICE_4_PLAN.md §4.1. USERS_*/
// ORGS_VIEW_ALL/WORKSPACES_VIEW_ALL/SYSTEM_ADMIN_STATUS_CHANGE are
// deliberately not added: every route they'd nominally back is gated by a
// direct isSystemAdminUser check (admin.js, GET /workspaces/admin/all), so
// none of them would ever be checked through this map — adding them would
// be exactly the unused-abstraction pattern this file otherwise avoids.

export const PERMISSIONS = {
  // Invite, roster, reset-password, and any role-change/removal/invitation
  // that only ever touches a plain MEMBER — see WORKSPACE_MANAGE_MANAGERS
  // below for the MANAGER-tier split (slice 4).
  WORKSPACE_MANAGE_MEMBERS: 'WORKSPACE_MANAGE_MEMBERS',
  // New, slice 4: any action that assigns, revokes, or removes a
  // MANAGER-tier membership (role-change to/from MANAGER, removing a
  // MANAGER). OWNER holds both this and WORKSPACE_MANAGE_MEMBERS; MANAGER
  // holds only WORKSPACE_MANAGE_MEMBERS — a real tightening versus slices
  // 1-3, where a MANAGER could already do all of this.
  WORKSPACE_MANAGE_MANAGERS: 'WORKSPACE_MANAGE_MANAGERS',
  // Archive and unarchive.
  WORKSPACE_ARCHIVE: 'WORKSPACE_ARCHIVE',
  // New, slice 4: OWNER only.
  WORKSPACE_TRANSFER_OWNERSHIP: 'WORKSPACE_TRANSFER_OWNERSHIP',
  // New, slice 4: OWNER only.
  WORKSPACE_CHANGE_VISIBILITY: 'WORKSPACE_CHANGE_VISIBILITY',
  // New, slice 4 (gap-fill): OWNER only. Consumed only by
  // POST /:workspaceId/settings, the only setter for managers_can_archive.
  WORKSPACE_MANAGE_SETTINGS: 'WORKSPACE_MANAGE_SETTINGS',
  // AI_SETTINGS_MANAGE/AUDIT_VIEW deliberately removed (Security.md,
  // 2026-07-15, HIGH finding): those two global surfaces are gated directly
  // on is_system_admin via requireSystemAdmin now, not a role-map
  // permission, so a permission constant for them would be unused — same
  // reasoning this file already gives for omitting USERS_*/ORGS_VIEW_ALL/etc.
  ORG_INVITE: 'ORG_INVITE',
  ORG_MANAGE_MEMBERS: 'ORG_MANAGE_MEMBERS',
};

// managers_can_archive (schema column since migration 0011) narrows a
// MANAGER's WORKSPACE_ARCHIVE grant further still, at check time in
// membershipService.js's requireWorkspacePermission — not expressible as a
// static map entry since it's a per-workspace toggle, not a fixed role
// grant. OWNER's archive access stays unconditional.
export const WORKSPACE_ROLE_PERMISSIONS = {
  OWNER: [
    PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
    PERMISSIONS.WORKSPACE_MANAGE_MANAGERS,
    PERMISSIONS.WORKSPACE_ARCHIVE,
    PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP,
    PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY,
    PERMISSIONS.WORKSPACE_MANAGE_SETTINGS,
  ],
  MANAGER: [PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE],
  MEMBER: [],
};

// Workspace-invitation creation (POST /:workspaceId/invitations) is
// deliberately gated on WORKSPACE_MANAGE_MEMBERS rather than a new
// WORKSPACE_INVITE permission — no route needs "can invite but not manage
// the roster" vs. the reverse, so a single-consumer permission constant
// would be unused abstraction. Introduce WORKSPACE_INVITE only once
// something actually differentiates the two.

// ORG_ADMIN gets both org permissions; ORG_MEMBER gets neither. Unlike
// WORKSPACE_ROLE_PERMISSIONS, org_role only has two values (ORG_ADMIN/
// ORG_MEMBER — migration 0011's DEFAULT and FEATURE_REQUEST.md's design),
// not three, so there's no OWNER-equivalent uniqueness tier here.
export const ORG_ROLE_PERMISSIONS = {
  ORG_ADMIN: [PERMISSIONS.ORG_INVITE, PERMISSIONS.ORG_MANAGE_MEMBERS],
  ORG_MEMBER: [],
};
