import { PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } from '../src/authz/permissions.js';

// Pure unit tests, no DB — the permission catalog is a static map
// (FEATURE_REQUEST.md entry 1, slice 1), so its correctness is checkable
// without exercising any route.

describe('WORKSPACE_ROLE_PERMISSIONS', () => {
  // FEATURE_REQUEST.md entry 1, slice 4: OWNER holds every workspace
  // permission that exists, including the three new OWNER-only ones
  // (transfer ownership, change visibility, manage settings) and the
  // MANAGER-tier split permission.
  test('OWNER holds every slice-4 workspace permission', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.OWNER).toEqual(
      expect.arrayContaining([
        PERMISSIONS.WORKSPACE_MANAGE_MEMBERS,
        PERMISSIONS.WORKSPACE_MANAGE_MANAGERS,
        PERMISSIONS.WORKSPACE_ARCHIVE,
        PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP,
        PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY,
        PERMISSIONS.WORKSPACE_MANAGE_SETTINGS,
      ]),
    );
  });

  // Slice 4 tightening: a MANAGER no longer holds everything OWNER does —
  // only WORKSPACE_MANAGE_MEMBERS and WORKSPACE_ARCHIVE (the latter further
  // narrowed at check time by managers_can_archive, tested in
  // workspaceArchiving.test.js).
  test('MANAGER holds only WORKSPACE_MANAGE_MEMBERS and WORKSPACE_ARCHIVE', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.MANAGER).toEqual(
      expect.arrayContaining([PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE]),
    );
    expect(WORKSPACE_ROLE_PERMISSIONS.MANAGER).toHaveLength(2);
  });

  test('MEMBER holds no elevated permissions', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.MEMBER).toEqual([]);
  });
});
