// Permission catalog for the enterprise authorization model
// (FEATURE_REQUEST.md entry 1). Slice 2 adds org-scoped permissions
// (ORG_INVITE, ORG_MANAGE_MEMBERS) alongside slice 1's workspace/system
// ones — still not the full future catalog (e.g. no WORKSPACE_TRANSFER_
// OWNERSHIP/WORKSPACE_CHANGE_VISIBILITY yet), just what this slice's routes
// actually consume.

export const PERMISSIONS = {
  // Invite, roster, role-change, reset-password, admin-create-user, and
  // (slice 2) workspace-invitation creation — see WORKSPACE_ROLE_PERMISSIONS
  // below for why invitation-creation doesn't get its own permission yet.
  WORKSPACE_MANAGE_MEMBERS: 'WORKSPACE_MANAGE_MEMBERS',
  // Archive and unarchive.
  WORKSPACE_ARCHIVE: 'WORKSPACE_ARCHIVE',
  AI_SETTINGS_MANAGE: 'AI_SETTINGS_MANAGE',
  AUDIT_VIEW: 'AUDIT_VIEW',
  // New, slice 2:
  ORG_INVITE: 'ORG_INVITE',
  ORG_MANAGE_MEMBERS: 'ORG_MANAGE_MEMBERS',
};

// OWNER and MANAGER both get everything in slice 1 — no manager-restriction
// feature lands yet. workspaces.managers_can_archive exists in the schema
// (migration 0011) but is deliberately not read here; wiring it into
// WORKSPACE_ARCHIVE so it can narrow a MANAGER's access is later-slice
// archive-endpoint work, not this slice's.
export const WORKSPACE_ROLE_PERMISSIONS = {
  OWNER: [PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE],
  MANAGER: [PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE],
  MEMBER: [],
};

// Workspace-invitation creation (POST /:workspaceId/invitations, slice 2)
// is deliberately gated on WORKSPACE_MANAGE_MEMBERS rather than a new
// WORKSPACE_INVITE permission — no route this slice or slice 1 needs "can
// invite but not manage the roster" vs. the reverse, so a single-consumer
// permission constant would be unused abstraction. Introduce
// WORKSPACE_INVITE only once something actually differentiates the two.

// ORG_ADMIN gets both org permissions; ORG_MEMBER gets neither. Unlike
// WORKSPACE_ROLE_PERMISSIONS, org_role only has two values (ORG_ADMIN/
// ORG_MEMBER — migration 0011's DEFAULT and FEATURE_REQUEST.md's design),
// not three, so there's no OWNER-equivalent uniqueness tier here.
export const ORG_ROLE_PERMISSIONS = {
  ORG_ADMIN: [PERMISSIONS.ORG_INVITE, PERMISSIONS.ORG_MANAGE_MEMBERS],
  ORG_MEMBER: [],
};
