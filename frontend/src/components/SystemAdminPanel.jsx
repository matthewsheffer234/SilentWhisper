import { Fragment, useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import CreateOrganizationModal from './CreateOrganizationModal.jsx';
import Pager from './Pager.jsx';
import WorkspaceSettingsSheet from './WorkspaceSettingsSheet.jsx';
import {
  createAdminUser,
  listAdminUsers,
  disableUser,
  enableUser,
  promoteUser,
  demoteUser,
  globalResetPassword,
  listUserOrganizations,
} from '../api/admin.js';
import {
  listAllWorkspacesAdmin,
  inviteWorkspaceMember,
  createWorkspaceMembershipInvitation,
  createWorkspaceInvitation,
  transferWorkspaceOwnership,
  changeWorkspaceVisibility,
  updateWorkspaceSettings,
  renameWorkspace,
  archiveWorkspace,
} from '../api/workspaces.js';
import {
  listOrganizations,
  createOrganization,
  addOrgMember,
  changeOrgMemberRole,
  removeOrgMember,
  renameOrganization,
  archiveOrganization,
  unarchiveOrganization,
} from '../api/organizations.js';
import { useAuth } from '../context/AuthContext.jsx';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4, plus
// the follow-up "manage organizations and existing users" pass. Structurally
// cloned from UserManagementPanel.jsx/OrgManagementPanel.jsx's established
// pattern, but workspace-agnostic — no workspace selector, since every
// action here (account creation/disable/enable/promote/demote/reset,
// cross-org oversight, org lifecycle) is system-wide, not scoped to any one
// workspace. All server calls redundantly re-check authorization
// server-side (a direct isSystemAdminUser gate) — this panel only ever
// being rendered for a system admin is a UI convenience, never the actual
// enforcement boundary, same as every other admin panel in this app.

const styles = {
  field: { marginBottom: 14 },
  label: {
    display: 'block',
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: 4,
  },
  select: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  sectionTitle: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)', margin: '18px 0 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)', marginBottom: 8 },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    background: 'var(--surface-alt)',
    color: 'var(--text-3)',
    fontWeight: 700,
    fontSize: 'var(--text-xs)',
    textTransform: 'uppercase',
  },
  td: { padding: '6px 8px', borderTop: '1px solid var(--border)', color: 'var(--text-1)', verticalAlign: 'middle' },
  secondaryUsername: { color: 'var(--text-3)', fontSize: 'var(--text-xs)', marginLeft: 6 },
  rowButton: {
    minHeight: 36,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  rowSelect: {
    minHeight: 36,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
  },
  submitButton: {
    marginTop: 6,
    minHeight: 44,
    padding: '0 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  row: { display: 'flex', gap: 12 },
  actionRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: '8px 0' },
  statusBadge: { fontSize: 'var(--text-xs)', fontWeight: 600 },
  manageSection: { padding: '10px 4px' },
  manageSectionTitle: { fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6 },
  inlineFormRow: { display: 'flex', gap: 6, marginTop: 6, marginBottom: 6 },
  orgRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 'var(--text-sm)' },
};

const PAGE_SIZE = 50;

function CreateAccountForm({ organizations, onSubmit }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [status, setStatus] = useState(null);

  const availableOrgs = organizations.filter((org) => !org.archivedAt);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await onSubmit({
        username,
        email,
        password,
        displayName: displayName || undefined,
        organizationId: organizationId || undefined,
      });
      setStatus({ type: 'success', message: `Created ${username} — share the password with them out of band.` });
      setUsername('');
      setEmail('');
      setPassword('');
      setDisplayName('');
      setOrganizationId('');
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create account' });
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="sysadmin-new-username">Username</label>
          <input id="sysadmin-new-username" style={styles.input} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="sysadmin-new-email">Email</label>
          <input
            id="sysadmin-new-email"
            type="email"
            style={styles.input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
      </div>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="sysadmin-new-password">Initial password</label>
          <input
            id="sysadmin-new-password"
            type="password"
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="sysadmin-new-displayname">Display name (optional)</label>
          <input
            id="sysadmin-new-displayname"
            style={styles.input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={username || 'Defaults to username'}
          />
        </div>
      </div>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="sysadmin-new-org">Organization</label>
          <select
            id="sysadmin-new-org"
            style={styles.select}
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
          >
            <option value="">(earliest-created org)</option>
            {availableOrgs.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }} />
      </div>
      <button type="submit" style={styles.submitButton}>Create account</button>
      {status && (
        <div style={{ marginTop: 8, fontSize: 'var(--text-sm)', color: status.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
          {status.message}
        </div>
      )}
    </form>
  );
}

// Expandable per-user detail row (cloned from UserManagementPanel.jsx's
// ResetPasswordRow toggle-open pattern, scaled up to cover both a global
// password reset and organization-membership management) — rendered as an
// extra full-width <tr> under the account row it belongs to.
function ManageUserRow({ targetUser, organizations, onResetPassword, onAddOrg, onChangeOrgRole, onRemoveFromOrg }) {
  const [newPassword, setNewPassword] = useState('');
  const [resetStatus, setResetStatus] = useState(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [userOrgs, setUserOrgs] = useState([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgsError, setOrgsError] = useState(null);
  const [addOrgId, setAddOrgId] = useState('');
  const [addOrgRole, setAddOrgRole] = useState('ORG_MEMBER');
  const [confirmRemoveOrg, setConfirmRemoveOrg] = useState(null); // org membership pending removal

  function loadUserOrgs() {
    setOrgsLoading(true);
    listUserOrganizations(targetUser.userId)
      .then(setUserOrgs)
      .catch((err) => setOrgsError(err.message || 'Failed to load organizations'))
      .finally(() => setOrgsLoading(false));
  }

  useEffect(() => {
    loadUserOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUser.userId]);

  function handleResetPassword(e) {
    e.preventDefault();
    if (!newPassword) return;
    setResetStatus(null);
    setConfirmingReset(true);
  }

  async function handleConfirmReset() {
    await onResetPassword(targetUser.userId, newPassword);
    setResetStatus({ type: 'success', message: 'Password reset' });
    setNewPassword('');
  }

  async function handleAddOrg(e) {
    e.preventDefault();
    if (!addOrgId) return;
    setOrgsError(null);
    try {
      await onAddOrg(addOrgId, targetUser.username, addOrgRole);
      setAddOrgId('');
      loadUserOrgs();
    } catch (err) {
      setOrgsError(err.message || 'Failed to add to organization');
    }
  }

  async function handleChangeRole(orgId, role) {
    setOrgsError(null);
    try {
      await onChangeOrgRole(orgId, targetUser.userId, role);
      loadUserOrgs();
    } catch (err) {
      setOrgsError(err.message || 'Failed to change role');
    }
  }

  async function handleRemove(orgId) {
    setOrgsError(null);
    try {
      await onRemoveFromOrg(orgId, targetUser.userId);
      loadUserOrgs();
    } catch (err) {
      setOrgsError(err.message || 'Failed to remove from organization');
    }
  }

  const availableOrgs = organizations.filter(
    (org) => !org.archivedAt && !userOrgs.some((uo) => uo.organizationId === org.id),
  );

  return (
    <tr>
      <td style={{ ...styles.td, background: 'var(--surface-alt)' }} colSpan={5}>
        <div style={styles.manageSection}>
          <div style={styles.manageSectionTitle}>Reset password</div>
          <form style={styles.inlineFormRow} onSubmit={handleResetPassword}>
            <input
              type="password"
              style={{ ...styles.input, flex: 1 }}
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <button type="submit" style={styles.rowButton}>Reset</button>
          </form>
          {resetStatus && (
            <div style={{ fontSize: 'var(--text-xs)', color: resetStatus.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
              {resetStatus.message}
            </div>
          )}

          <div style={{ ...styles.manageSectionTitle, marginTop: 14 }}>Organizations</div>
          {orgsError && <div style={styles.error}>{orgsError}</div>}
          <div data-testid="manage-user-orgs">
          {orgsLoading ? (
            <div style={styles.empty}>Loading…</div>
          ) : userOrgs.length === 0 ? (
            <div style={styles.empty}>Not a member of any organization.</div>
          ) : (
            userOrgs.map((uo) => (
              <div key={uo.organizationId} data-testid={`org-membership-${uo.organizationId}`} style={styles.orgRow}>
                <span style={{ flex: 1 }}>
                  {uo.organizationName}
                  {uo.archivedAt ? ' (archived)' : ''}
                </span>
                <select
                  style={styles.rowSelect}
                  value={uo.role}
                  onChange={(e) => handleChangeRole(uo.organizationId, e.target.value)}
                  aria-label={`Role for ${targetUser.username} in ${uo.organizationName}`}
                >
                  <option value="ORG_MEMBER">Member</option>
                  <option value="ORG_ADMIN">Admin</option>
                </select>
                <button type="button" style={styles.rowButton} onClick={() => setConfirmRemoveOrg(uo)}>
                  Remove
                </button>
              </div>
            ))
          )}
          </div>
          <form style={styles.inlineFormRow} onSubmit={handleAddOrg}>
            <select
              style={{ ...styles.select, flex: 1 }}
              value={addOrgId}
              onChange={(e) => setAddOrgId(e.target.value)}
              aria-label="Add to organization"
            >
              <option value="">Add to organization…</option>
              {availableOrgs.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
            <select style={styles.rowSelect} value={addOrgRole} onChange={(e) => setAddOrgRole(e.target.value)} aria-label="Role">
              <option value="ORG_MEMBER">Member</option>
              <option value="ORG_ADMIN">Admin</option>
            </select>
            <button type="submit" style={styles.rowButton} disabled={!addOrgId}>Add</button>
          </form>
        </div>
        {confirmingReset && (
          <ConfirmDialog
            title="Reset Password"
            message={`Reset the password for ${targetUser.displayName || targetUser.username}? They'll be signed out of every session and must use the new password to sign in again.`}
            confirmLabel="Reset Password"
            onConfirm={handleConfirmReset}
            onClose={() => setConfirmingReset(false)}
          />
        )}
        {confirmRemoveOrg && (
          <ConfirmDialog
            title="Remove Member"
            message={`Remove ${targetUser.displayName || targetUser.username} from ${confirmRemoveOrg.organizationName}? They will lose access to every workspace they hold through it.`}
            confirmLabel="Remove"
            onConfirm={() => handleRemove(confirmRemoveOrg.organizationId)}
            onClose={() => setConfirmRemoveOrg(null)}
          />
        )}
      </td>
    </tr>
  );
}

// Inline-rename (cloned from ResetPasswordRow's toggle-open pattern) plus an
// archive/unarchive toggle, one row per organization.
function OrganizationRow({ org, onRename, onArchive, onUnarchive }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const [status, setStatus] = useState(null);

  async function handleSave(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await onRename(org.id, name);
      setEditing(false);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to rename' });
    }
  }

  async function handleArchiveToggle() {
    setStatus(null);
    try {
      if (org.archivedAt) {
        await onUnarchive(org.id);
      } else {
        await onArchive(org.id);
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to update organization' });
    }
  }

  return (
    <tr data-testid={`org-row-${org.id}`}>
      <td style={styles.td}>
        {editing ? (
          <form style={styles.inlineFormRow} onSubmit={handleSave}>
            <input style={{ ...styles.input, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} required />
            <button type="submit" style={styles.rowButton}>Save</button>
            <button
              type="button"
              style={styles.rowButton}
              onClick={() => {
                setEditing(false);
                setName(org.name);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          org.name
        )}
      </td>
      <td style={styles.td}>{org.archivedAt ? 'Archived' : ''}</td>
      <td style={styles.td}>
        <div style={styles.actionRow}>
          {!editing && (
            <button type="button" style={styles.rowButton} onClick={() => setEditing(true)}>Rename</button>
          )}
          <button type="button" style={styles.rowButton} onClick={handleArchiveToggle}>
            {org.archivedAt ? 'Unarchive' : 'Archive'}
          </button>
        </div>
        {status && <div style={{ fontSize: 'var(--text-xs)', color: '#c0392b', marginTop: 4 }}>{status.message}</div>}
      </td>
    </tr>
  );
}

export default function SystemAdminPanel({ onClose }) {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsTotal, setAccountsTotal] = useState(0);
  const [accountsOffset, setAccountsOffset] = useState(0);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  const [allWorkspaces, setAllWorkspaces] = useState([]);
  const [workspacesTotal, setWorkspacesTotal] = useState(0);
  const [workspacesOffset, setWorkspacesOffset] = useState(0);
  // FEATURE_REQUEST.md: "any system admin should be able to fully manage
  // all workspaces" — the workspace this admin is currently managing via
  // WorkspaceSettingsSheet in admin-override mode, opened from a row's
  // "Manage" button below regardless of whether this admin is a member.
  const [managingWorkspace, setManagingWorkspace] = useState(null);
  const [managingUserId, setManagingUserId] = useState(null);
  const [orgsError, setOrgsError] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null); // account pending disable
  const [createOrgOpen, setCreateOrgOpen] = useState(false);

  function loadAccounts(offset = accountsOffset) {
    setAccountsLoading(true);
    setAccountsError(null);
    listAdminUsers({ limit: PAGE_SIZE, offset })
      .then((res) => {
        setAccounts(res.users);
        setAccountsTotal(res.total);
        setAccountsOffset(res.offset);
      })
      .catch((err) => setAccountsError(err.message || 'Failed to load accounts'))
      .finally(() => setAccountsLoading(false));
  }

  function loadWorkspaces(offset = workspacesOffset) {
    listAllWorkspacesAdmin({ limit: PAGE_SIZE, offset })
      .then((res) => {
        setAllWorkspaces(res.workspaces);
        setWorkspacesTotal(res.total);
        setWorkspacesOffset(res.offset);
      })
      .catch(() => {
        setAllWorkspaces([]);
        setWorkspacesTotal(0);
      });
  }

  function loadOrganizations() {
    listOrganizations().then(setOrganizations).catch(() => setOrganizations([]));
  }

  // Same shape as ChatShell.jsx's own workspace-management handlers — this
  // panel manages its own separate allWorkspaces list (member-independent,
  // from GET /workspaces/admin/all) rather than reusing ChatShell's
  // member-only `workspaces` state, since a system admin managing a
  // workspace they don't belong to would never appear in that list at all.
  function handleAdminInviteMember(workspaceId, username, role) {
    return inviteWorkspaceMember(workspaceId, username, role);
  }
  function handleAdminInviteMembership(workspaceId, userId, role) {
    return createWorkspaceMembershipInvitation(workspaceId, userId, role);
  }
  function handleAdminCreateInviteLink(workspaceId, role) {
    return createWorkspaceInvitation(workspaceId, role);
  }
  async function handleAdminArchiveWorkspace(workspaceId) {
    const { archivedAt } = await archiveWorkspace(workspaceId);
    setAllWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, archivedAt } : ws)));
  }
  async function handleAdminTransferOwnership(workspaceId, username) {
    await transferWorkspaceOwnership(workspaceId, username);
    loadWorkspaces(workspacesOffset);
  }
  async function handleAdminChangeVisibility(workspaceId, visibility) {
    await changeWorkspaceVisibility(workspaceId, visibility);
    setAllWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, visibility } : ws)));
    setManagingWorkspace((prev) => (prev && prev.id === workspaceId ? { ...prev, visibility } : prev));
  }
  async function handleAdminToggleManagersCanArchive(workspaceId, managersCanArchive) {
    await updateWorkspaceSettings(workspaceId, { managersCanArchive });
    setAllWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, managersCanArchive } : ws)));
    setManagingWorkspace((prev) => (prev && prev.id === workspaceId ? { ...prev, managersCanArchive } : prev));
  }
  // FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"), Part 2.
  async function handleAdminRenameWorkspace(workspaceId, name) {
    await renameWorkspace(workspaceId, name);
    setAllWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, name } : ws)));
    setManagingWorkspace((prev) => (prev && prev.id === workspaceId ? { ...prev, name } : prev));
  }

  useEffect(() => {
    loadOrganizations();
    loadAccounts(0);
    loadWorkspaces(0);
  }, []);

  async function handleCreateAccount(details) {
    await createAdminUser(details);
    loadAccounts();
  }

  async function handleDisable(userId) {
    try {
      await disableUser(userId);
      loadAccounts();
    } catch (err) {
      setAccountsError(err.message || 'Failed to disable account');
    }
  }

  async function handleEnable(userId) {
    try {
      await enableUser(userId);
      loadAccounts();
    } catch (err) {
      setAccountsError(err.message || 'Failed to enable account');
    }
  }

  async function handlePromote(userId) {
    try {
      await promoteUser(userId);
      loadAccounts();
    } catch (err) {
      setAccountsError(err.message || 'Failed to promote account');
    }
  }

  async function handleDemote(userId) {
    try {
      await demoteUser(userId);
      loadAccounts();
    } catch (err) {
      setAccountsError(err.message || 'Failed to demote account');
    }
  }

  function handleGlobalResetPassword(userId, newPassword) {
    return globalResetPassword(userId, newPassword);
  }

  function handleAddUserToOrg(orgId, username, role) {
    return addOrgMember(orgId, username, role);
  }

  function handleChangeUserOrgRole(orgId, userId, role) {
    return changeOrgMemberRole(orgId, userId, role);
  }

  function handleRemoveUserFromOrg(orgId, userId) {
    return removeOrgMember(orgId, userId);
  }

  // FEATURE_REQUEST.md's "manage organizations (create, modify, delete) in
  // the frontend" entry: opens the same CreateOrganizationModal the
  // workspace switcher's "+ Create organization…" item already uses (same
  // onCreate prop shape), refreshing the same organizations list state the
  // table already reloads after rename/archive/unarchive.
  async function handleCreateOrg(name) {
    await createOrganization(name);
    loadOrganizations();
    setCreateOrgOpen(false);
  }

  async function handleRenameOrg(orgId, name) {
    await renameOrganization(orgId, name);
    loadOrganizations();
  }

  async function handleArchiveOrg(orgId) {
    try {
      await archiveOrganization(orgId);
      loadOrganizations();
    } catch (err) {
      setOrgsError(err.message || 'Failed to archive organization');
    }
  }

  async function handleUnarchiveOrg(orgId) {
    try {
      await unarchiveOrganization(orgId);
      loadOrganizations();
    } catch (err) {
      setOrgsError(err.message || 'Failed to unarchive organization');
    }
  }

  return (
    <Sheet
      title="System Admin"
      ariaLabel="system admin"
      subtitle="Create accounts, adjust privileges, reset passwords, manage organization membership, and review every workspace across every organization."
      onClose={onClose}
      width={760}
      maxHeight="86vh"
    >
        <div style={styles.sectionTitle}>Create account</div>
        <CreateAccountForm organizations={organizations} onSubmit={handleCreateAccount} />

        <div style={styles.sectionTitle}>All accounts</div>
        {accountsError && <div style={styles.error}>{accountsError}</div>}
        {accountsLoading ? (
          <div style={styles.empty}>Loading…</div>
        ) : accounts.length === 0 ? (
          <div style={styles.empty}>No accounts yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Member</th>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>System admin</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const isSelf = a.userId === user?.id;
                return (
                  <Fragment key={a.userId}>
                    <tr>
                      <td style={styles.td}>
                        {a.displayName || a.username}
                        {a.displayName && a.displayName !== a.username && (
                          <span style={styles.secondaryUsername}>@{a.username}</span>
                        )}
                      </td>
                      <td style={styles.td}>{a.email}</td>
                      <td style={styles.td}>
                        <span style={{ ...styles.statusBadge, color: a.status === 'DISABLED' ? '#c0392b' : 'var(--brg)' }}>
                          {a.status}
                        </span>
                      </td>
                      <td style={styles.td}>{a.isSystemAdmin ? 'Yes' : ''}</td>
                      <td style={styles.td}>
                        <div style={styles.actionRow}>
                          {/* Disabled for the caller's own row, mirroring the
                              backend's self-disable/self-demote 400s —
                              avoids a guaranteed-failing click. */}
                          {a.status === 'DISABLED' ? (
                            <button type="button" style={styles.rowButton} onClick={() => handleEnable(a.userId)}>
                              Enable
                            </button>
                          ) : (
                            <button type="button" style={styles.rowButton} disabled={isSelf} onClick={() => setConfirmDisable(a)}>
                              Disable
                            </button>
                          )}
                          {a.isSystemAdmin ? (
                            <button type="button" style={styles.rowButton} disabled={isSelf} onClick={() => handleDemote(a.userId)}>
                              Demote
                            </button>
                          ) : (
                            <button type="button" style={styles.rowButton} onClick={() => handlePromote(a.userId)}>
                              Promote
                            </button>
                          )}
                          <button
                            type="button"
                            style={styles.rowButton}
                            onClick={() => setManagingUserId(managingUserId === a.userId ? null : a.userId)}
                          >
                            {managingUserId === a.userId ? 'Close' : 'Manage'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {managingUserId === a.userId && (
                      <ManageUserRow
                        key={`${a.userId}-manage`}
                        targetUser={a}
                        organizations={organizations}
                        onResetPassword={handleGlobalResetPassword}
                        onAddOrg={handleAddUserToOrg}
                        onChangeOrgRole={handleChangeUserOrgRole}
                        onRemoveFromOrg={handleRemoveUserFromOrg}
                      />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <Pager offset={accountsOffset} limit={PAGE_SIZE} total={accountsTotal} onPageChange={loadAccounts} />

        <div style={{ ...styles.row, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={styles.sectionTitle}>Organizations</div>
          <button type="button" style={styles.rowButton} onClick={() => setCreateOrgOpen(true)}>
            Create organization…
          </button>
        </div>
        {orgsError && <div style={styles.error}>{orgsError}</div>}
        {organizations.length === 0 ? (
          <div style={styles.empty}>No organizations yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <OrganizationRow
                  key={org.id}
                  org={org}
                  onRename={handleRenameOrg}
                  onArchive={handleArchiveOrg}
                  onUnarchive={handleUnarchiveOrg}
                />
              ))}
            </tbody>
          </table>
        )}

        <div style={styles.sectionTitle}>All workspaces</div>
        {allWorkspaces.length === 0 ? (
          <div style={styles.empty}>No workspaces yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Owner</th>
                <th style={styles.th}>Organization</th>
                <th style={styles.th}>Visibility</th>
                <th style={styles.th}>Archived</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {allWorkspaces.map((ws) => (
                <tr key={ws.id}>
                  <td style={styles.td}>{ws.name}</td>
                  <td style={styles.td}>{ws.ownerDisplayName || ws.ownerUsername}</td>
                  <td style={styles.td}>{ws.organizationName}</td>
                  <td style={styles.td}>{ws.visibility}</td>
                  <td style={styles.td}>{ws.archivedAt ? 'Yes' : ''}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.rowButton} onClick={() => setManagingWorkspace(ws)}>
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager offset={workspacesOffset} limit={PAGE_SIZE} total={workspacesTotal} onPageChange={loadWorkspaces} />
        {managingWorkspace && (
          <WorkspaceSettingsSheet
            workspace={managingWorkspace}
            isSystemAdminOverride
            onClose={() => setManagingWorkspace(null)}
            onInviteMember={(username, role) => handleAdminInviteMember(managingWorkspace.id, username, role)}
            onInviteMembership={(userId, role) => handleAdminInviteMembership(managingWorkspace.id, userId, role)}
            onCreateInviteLink={(role) => handleAdminCreateInviteLink(managingWorkspace.id, role)}
            onTransferOwnership={(username) => handleAdminTransferOwnership(managingWorkspace.id, username)}
            onChangeVisibility={(visibility) => handleAdminChangeVisibility(managingWorkspace.id, visibility)}
            onToggleManagersCanArchive={(value) => handleAdminToggleManagersCanArchive(managingWorkspace.id, value)}
            onRenameWorkspace={(name) => handleAdminRenameWorkspace(managingWorkspace.id, name)}
            onArchiveWorkspace={() => handleAdminArchiveWorkspace(managingWorkspace.id)}
          />
        )}
        {confirmDisable && (
          <ConfirmDialog
            title="Disable Account"
            message={`Disable ${confirmDisable.displayName || confirmDisable.username}'s account? They'll be signed out of every session immediately and won't be able to sign in again until re-enabled.`}
            confirmLabel="Disable"
            onConfirm={() => handleDisable(confirmDisable.userId)}
            onClose={() => setConfirmDisable(null)}
          />
        )}
        {createOrgOpen && (
          <CreateOrganizationModal onClose={() => setCreateOrgOpen(false)} onCreate={handleCreateOrg} />
        )}
    </Sheet>
  );
}
