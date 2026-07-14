import { useEffect, useState } from 'react';
import {
  listWorkspaceMembers,
  changeWorkspaceMemberRole,
  createWorkspaceUser,
  resetWorkspaceMemberPassword,
} from '../api/workspaces.js';

// FEATURE_REQUEST.md: admin dashboard for user provisioning, role
// assignment, and password reset. Every action here is workspace-scoped
// (unlike the workspace-agnostic AiSettingsPanel/AuditDashboard), so this
// panel needs its own workspace selector — limited to workspaces the
// current user administers, the same set isSelectedWorkspaceAdmin already
// checks against for the sidebar's InviteMemberForm. All server calls
// redundantly re-check authorization server-side (requireWorkspaceAdmin) —
// this panel only ever being rendered for an admin is a UI convenience,
// never the actual enforcement boundary, same as AiSettingsPanel already
// documents.

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  panel: {
    width: 640,
    maxWidth: '94vw',
    maxHeight: '86vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface)',
    borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
    padding: '20px 24px',
    overflowY: 'auto',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-1)' },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-lg)',
  },
  subtitle: { fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 16 },
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

function ResetPasswordRow({ member, onReset }) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await onReset(member.userId, newPassword);
      setStatus({ type: 'success', message: 'Password reset' });
      setNewPassword('');
      setOpen(false);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to reset password' });
    }
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
    </div>
  );
}

function AddUserForm({ onSubmit }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await onSubmit({ username, email, password, role });
      setStatus({ type: 'success', message: `Created ${username} — share the password with them out of band.` });
      setUsername('');
      setEmail('');
      setPassword('');
      setRole('MEMBER');
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create user' });
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="new-user-username">Username</label>
          <input id="new-user-username" style={styles.input} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="new-user-email">Email</label>
          <input id="new-user-email" type="email" style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
      </div>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="new-user-password">Initial password</label>
          <input
            id="new-user-password"
            type="password"
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="new-user-role">Role</label>
          <select id="new-user-role" style={styles.select} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="MEMBER">Member</option>
            <option value="MANAGER">Manager</option>
          </select>
        </div>
      </div>
      <button type="submit" style={styles.submitButton}>Add user</button>
      {status && (
        <div style={{ marginTop: 8, fontSize: 'var(--text-sm)', color: status.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
          {status.message}
        </div>
      )}
    </form>
  );
}

export default function UserManagementPanel({ workspaces, onClose }) {
  const adminWorkspaces = workspaces.filter((ws) => ['OWNER', 'MANAGER'].includes(ws.role));
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(adminWorkspaces[0]?.id ?? null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function loadMembers(workspaceId) {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    listWorkspaceMembers(workspaceId)
      .then(setMembers)
      .catch((err) => setError(err.message || 'Failed to load members'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadMembers(selectedWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  async function handleRoleChange(userId, role) {
    try {
      await changeWorkspaceMemberRole(selectedWorkspaceId, userId, role);
      loadMembers(selectedWorkspaceId);
    } catch (err) {
      setError(err.message || 'Failed to change role');
    }
  }

  async function handleAddUser(details) {
    await createWorkspaceUser(selectedWorkspaceId, details);
    loadMembers(selectedWorkspaceId);
  }

  async function handleResetPassword(userId, newPassword) {
    await resetWorkspaceMemberPassword(selectedWorkspaceId, userId, newPassword);
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Manage Users</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close manage users">×</button>
        </div>
        <div style={styles.subtitle}>Assign roles, add users, and reset passwords for a workspace you administer.</div>

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
                <th style={styles.th}>Username</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td style={styles.td}>{m.username}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={styles.sectionTitle}>Add a user</div>
        <AddUserForm onSubmit={handleAddUser} />
      </div>
    </div>
  );
}
