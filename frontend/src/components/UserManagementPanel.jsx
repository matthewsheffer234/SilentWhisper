import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import {
  listWorkspaceMembers,
  changeWorkspaceMemberRole,
  removeWorkspaceMember,
  resetWorkspaceMemberPassword,
  listWorkspaceInvitations,
} from '../api/workspaces.js';
import { revokeInvitation } from '../api/invitations.js';
import { PERMISSIONS, hasPermission } from '../authz/permissions.js';

// FEATURE_REQUEST.md: admin dashboard for role assignment, member removal,
// and password reset. Every action here is workspace-scoped (unlike the
// workspace-agnostic AiSettingsPanel/AuditDashboard), so this panel needs
// its own workspace selector — limited to workspaces the current user
// administers, the same set isSelectedWorkspaceAdmin already checks against
// for the sidebar's InviteMemberForm. All server calls redundantly re-check
// authorization server-side (requireWorkspacePermission) — this panel only
// ever being rendered for an admin is a UI convenience, never the actual
// enforcement boundary, same as AiSettingsPanel already documents.
//
// Direct account provisioning (AddUserForm) is removed as of
// FEATURE_REQUEST.md entry 1, slice 4: a plain workspace OWNER/MANAGER can
// no longer create accounts at all — only a system admin can, via
// SystemAdminPanel.jsx — this panel falls back to inviting (below) for
// people who don't have an account yet.

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
  saved: { color: 'var(--brg)', fontSize: 'var(--text-sm)' },
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
  rowSelect: {
    minHeight: 36,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
  },
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
  inlineResetForm: { display: 'flex', gap: 6, marginTop: 6 },
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
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: '8px 0' },
};

// FEATURE_REQUEST.md's "confirmation and recovery for destructive or
// high-impact actions" entry: entering a new password and submitting the
// inline form no longer resets it directly — it opens a ConfirmDialog
// naming the target and the consequence (every other session of theirs is
// revoked), and only the dialog's own confirm click calls the API.
function ResetPasswordRow({ member, onReset }) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }
  const [confirming, setConfirming] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!newPassword) return;
    setStatus(null);
    setConfirming(true);
  }

  async function handleConfirm() {
    await onReset(member.userId, newPassword);
    setStatus({ type: 'success', message: 'Password reset' });
    setNewPassword('');
    setOpen(false);
  }

  return (
    <div>
      {open ? (
        <form style={styles.inlineResetForm} onSubmit={handleSubmit}>
          <input
            type="password"
            style={styles.input}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus
            required
          />
          <button type="submit" style={styles.rowButton}>Confirm</button>
          <button type="button" style={styles.rowButton} onClick={() => setOpen(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" style={styles.rowButton} onClick={() => setOpen(true)}>
          Reset password
        </button>
      )}
      {/* Rendered regardless of open/closed — a successful reset closes the
          form (setOpen(false)) in the same tick it sets this message, so
          gating the message behind `open` would make it disappear before
          it could ever be seen. */}
      {status && (
        <div style={{ fontSize: 'var(--text-xs)', marginTop: 4, color: status.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
          {status.message}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="Reset Password"
          message={`Reset the password for ${member.displayName || member.username}? They'll be signed out of every session and must use the new password to sign in again.`}
          confirmLabel="Reset Password"
          onConfirm={handleConfirm}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

export default function UserManagementPanel({ workspaces, onClose }) {
  const adminWorkspaces = workspaces.filter((ws) => hasPermission(ws.role, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS));
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(adminWorkspaces[0]?.id ?? null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [invitations, setInvitations] = useState([]);
  const [confirmRemove, setConfirmRemove] = useState(null); // member pending removal
  const [confirmRevoke, setConfirmRevoke] = useState(null); // invitation pending revocation

  function loadMembers(workspaceId) {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    listWorkspaceMembers(workspaceId)
      .then(setMembers)
      .catch((err) => setError(err.message || 'Failed to load members'))
      .finally(() => setLoading(false));
  }

  function loadInvitations(workspaceId) {
    if (!workspaceId) return;
    listWorkspaceInvitations(workspaceId)
      .then(setInvitations)
      .catch(() => setInvitations([]));
  }

  useEffect(() => {
    loadMembers(selectedWorkspaceId);
    loadInvitations(selectedWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  async function handleRevokeInvitation(invitationId) {
    await revokeInvitation(invitationId);
    loadInvitations(selectedWorkspaceId);
  }

  async function handleRoleChange(userId, role) {
    try {
      await changeWorkspaceMemberRole(selectedWorkspaceId, userId, role);
      loadMembers(selectedWorkspaceId);
    } catch (err) {
      setError(err.message || 'Failed to change role');
    }
  }

  async function handleRemove(userId) {
    try {
      await removeWorkspaceMember(selectedWorkspaceId, userId);
      loadMembers(selectedWorkspaceId);
    } catch (err) {
      setError(err.message || 'Failed to remove member');
    }
  }

  async function handleResetPassword(userId, newPassword) {
    await resetWorkspaceMemberPassword(selectedWorkspaceId, userId, newPassword);
  }

  return (
    <Sheet
      title="Manage Users"
      ariaLabel="manage users"
      subtitle="Assign roles, remove members, and reset passwords for a workspace you administer. To add someone new, create an invite link below or, for a brand-new account, ask a system admin."
      onClose={onClose}
      width={640}
      maxHeight="86vh"
    >
        <div style={styles.field}>
          <label style={styles.label} htmlFor="manage-users-workspace">Workspace</label>
          <select
            id="manage-users-workspace"
            style={styles.select}
            value={selectedWorkspaceId ?? ''}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
          >
            {adminWorkspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.sectionTitle}>Members</div>
        {loading ? (
          <div style={styles.empty}>Loading…</div>
        ) : members.length === 0 ? (
          <div style={styles.empty}>No members yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Member</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}></th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td style={styles.td}>
                    {m.displayName || m.username}
                    {m.displayName && m.displayName !== m.username && (
                      <span style={styles.secondaryUsername}>@{m.username}</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <select
                      style={styles.rowSelect}
                      value={m.role}
                      onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                      aria-label={`Role for ${m.username}`}
                    >
                      <option value="MEMBER">Member</option>
                      <option value="MANAGER">Manager</option>
                    </select>
                  </td>
                  <td style={styles.td}>
                    <ResetPasswordRow member={m} onReset={handleResetPassword} />
                  </td>
                  <td style={styles.td}>
                    <button type="button" style={styles.rowButton} onClick={() => setConfirmRemove(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={styles.sectionTitle}>Pending invitations</div>
        {invitations.length === 0 ? (
          <div style={styles.empty}>No pending invitations.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td style={styles.td}>{inv.email}</td>
                  <td style={styles.td}>{inv.invitedRole}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.rowSelect} onClick={() => setConfirmRevoke(inv)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {confirmRemove && (
          <ConfirmDialog
            title="Remove Member"
            message={`Remove ${confirmRemove.displayName || confirmRemove.username} from this workspace? They will immediately lose access to every channel here.`}
            confirmLabel="Remove"
            onConfirm={() => handleRemove(confirmRemove.userId)}
            onClose={() => setConfirmRemove(null)}
          />
        )}
        {confirmRevoke && (
          <ConfirmDialog
            title="Revoke Invitation"
            message={`Revoke the pending invitation for ${confirmRevoke.email}? The invite link will stop working immediately.`}
            confirmLabel="Revoke"
            onConfirm={() => handleRevokeInvitation(confirmRevoke.id)}
            onClose={() => setConfirmRevoke(null)}
          />
        )}
    </Sheet>
  );
}
