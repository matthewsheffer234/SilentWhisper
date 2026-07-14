// Permission catalog for the enterprise authorization model
// (FEATURE_REQUEST.md entry 1). Slice 1 scope only: the constants and maps
// below cover exactly what workspaces.js/ai.js/audit.js need to keep
// working under the new OWNER/MANAGER/MEMBER role model. Org-scoped
// permissions (ORG_INVITE, ORG_MANAGE_MEMBERS, ...) are not defined here —
// nothing in slice 1 reads organization_members, since org CRUD routes are
// a later slice.

export const PERMISSIONS = {
  // Invite, roster, role-change, reset-password, admin-create-user.
  WORKSPACE_MANAGE_MEMBERS: 'WORKSPACE_MANAGE_MEMBERS',
  // Archive and unarchive.
  WORKSPACE_ARCHIVE: 'WORKSPACE_ARCHIVE',
  AI_SETTINGS_MANAGE: 'AI_SETTINGS_MANAGE',
  AUDIT_VIEW: 'AUDIT_VIEW',
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
