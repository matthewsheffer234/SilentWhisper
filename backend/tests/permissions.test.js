import { PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } from '../src/authz/permissions.js';

// Pure unit tests, no DB — the permission catalog is a static map
// (FEATURE_REQUEST.md entry 1, slice 1), so its correctness is checkable
// without exercising any route.

describe('WORKSPACE_ROLE_PERMISSIONS', () => {
  test('OWNER holds every slice-1 workspace permission', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.OWNER).toEqual(
      expect.arrayContaining([PERMISSIONS.WORKSPACE_MANAGE_MEMBERS, PERMISSIONS.WORKSPACE_ARCHIVE]),
    );
  });

  test('MANAGER holds the same permissions as OWNER in slice 1 (no manager-restriction feature yet)', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.MANAGER).toEqual(WORKSPACE_ROLE_PERMISSIONS.OWNER);
  });

  test('MEMBER holds no elevated permissions', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.MEMBER).toEqual([]);
  });
});
