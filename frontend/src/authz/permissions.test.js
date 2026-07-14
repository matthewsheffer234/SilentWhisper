import { describe, test, expect } from 'vitest';
import { PERMISSIONS, hasPermission, hasOrgPermission, hasSystemPermission, hasOrgManagementAccess } from './permissions.js';

// FEATURE_REQUEST.md entry 1, slice 3. Pure-function tests only (no jsdom
// in this frontend's Vitest setup — same reason ThemeContext.test.jsx only
// covers resolveTheme).

describe('hasPermission', () => {
  test('OWNER holds WORKSPACE_MANAGE_MEMBERS and WORKSPACE_ARCHIVE', () => {
    expect(hasPermission('OWNER', PERMISSIONS.WORKSPACE_MANAGE_MEMBERS)).toBe(true);
    expect(hasPermission('OWNER', PERMISSIONS.WORKSPACE_ARCHIVE)).toBe(true);
  });

  test('MANAGER holds the same permissions as OWNER', () => {
    expect(hasPermission('MANAGER', PERMISSIONS.WORKSPACE_MANAGE_MEMBERS)).toBe(true);
    expect(hasPermission('MANAGER', PERMISSIONS.WORKSPACE_ARCHIVE)).toBe(true);
  });

  test('MEMBER holds neither', () => {
    expect(hasPermission('MEMBER', PERMISSIONS.WORKSPACE_MANAGE_MEMBERS)).toBe(false);
    expect(hasPermission('MEMBER', PERMISSIONS.WORKSPACE_ARCHIVE)).toBe(false);
  });

  test('an unknown/null role holds nothing, rather than throwing', () => {
    expect(hasPermission(null, PERMISSIONS.WORKSPACE_ARCHIVE)).toBe(false);
    expect(hasPermission('NOT_A_ROLE', PERMISSIONS.WORKSPACE_ARCHIVE)).toBe(false);
  });
});

describe('hasOrgPermission', () => {
  test('ORG_ADMIN holds ORG_INVITE and ORG_MANAGE_MEMBERS', () => {
    expect(hasOrgPermission('ORG_ADMIN', PERMISSIONS.ORG_INVITE)).toBe(true);
    expect(hasOrgPermission('ORG_ADMIN', PERMISSIONS.ORG_MANAGE_MEMBERS)).toBe(true);
  });

  test('ORG_MEMBER holds neither', () => {
    expect(hasOrgPermission('ORG_MEMBER', PERMISSIONS.ORG_INVITE)).toBe(false);
    expect(hasOrgPermission('ORG_MEMBER', PERMISSIONS.ORG_MANAGE_MEMBERS)).toBe(false);
  });

  test('a null role (system-admin-sees-all branch) holds nothing, rather than throwing', () => {
    expect(hasOrgPermission(null, PERMISSIONS.ORG_INVITE)).toBe(false);
  });
});

describe('hasOrgManagementAccess', () => {
  test('a system admin has access even when GET /organizations reports role: null', () => {
    expect(hasOrgManagementAccess(true, null)).toBe(true);
  });

  test('a non-admin ORG_ADMIN has access via the plain role check', () => {
    expect(hasOrgManagementAccess(false, 'ORG_ADMIN')).toBe(true);
  });

  test('a non-admin ORG_MEMBER has no access', () => {
    expect(hasOrgManagementAccess(false, 'ORG_MEMBER')).toBe(false);
  });
});

describe('hasSystemPermission', () => {
  test('a system admin always passes, even with no workspace memberships', () => {
    expect(hasSystemPermission(true, [])).toBe(true);
  });

  test('a non-system-admin with an OWNER workspace membership passes', () => {
    expect(hasSystemPermission(false, [{ role: 'OWNER' }])).toBe(true);
  });

  test('a non-system-admin with a MANAGER workspace membership passes', () => {
    expect(hasSystemPermission(false, [{ role: 'MANAGER' }])).toBe(true);
  });

  test('a non-system-admin with only MEMBER workspace memberships fails', () => {
    expect(hasSystemPermission(false, [{ role: 'MEMBER' }])).toBe(false);
  });

  test('a non-system-admin with no workspace memberships fails', () => {
    expect(hasSystemPermission(false, [])).toBe(false);
  });
});
