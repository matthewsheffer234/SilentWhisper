import { useEffect, useState } from 'react';
import { createAdminUser, listAdminUsers, disableUser, enableUser } from '../api/admin.js';
import { listAllWorkspacesAdmin } from '../api/workspaces.js';
import { listOrganizations } from '../api/organizations.js';
import { useAuth } from '../context/AuthContext.jsx';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 4.
// Structurally cloned from UserManagementPanel.jsx/OrgManagementPanel.jsx's
// established pattern, but workspace-agnostic — no workspace selector, since
// every action here (account creation/disable/enable, cross-org oversight)
// is system-wide, not scoped to any one workspace or organization. All
// server calls redundantly re-check authorization server-side (a direct
// isSystemAdminUser gate) — this panel only ever being rendered for a
// system admin is a UI convenience, never the actual enforcement boundary,
// same as every other admin panel in this app.

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
    width: 720,
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
  statusBadge: { fontSize: 'var(--text-xs)', fontWeight: 600 },
};

function CreateAccountForm({ organizations, onSubmit }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await onSubmit({ username, email, password, organizationId: organizationId || undefined });
      setStatus({ type: 'success', message: `Created ${username} — share the password with them out of band.` });
      setUsername('');
      setEmail('');
      setPassword('');
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
          <label style={styles.label} htmlFor="sysadmin-new-org">Organization</label>
          <select
            id="sysadmin-new-org"
            style={styles.select}
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
          >
            <option value="">(earliest-created org)</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
        </div>
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

export default function SystemAdminPanel({ onClose }) {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  const [allWorkspaces, setAllWorkspaces] = useState([]);

  function loadAccounts() {
    setAccountsLoading(true);
    setAccountsError(null);
    listAdminUsers()
      .then(setAccounts)
      .catch((err) => setAccountsError(err.message || 'Failed to load accounts'))
      .finally(() => setAccountsLoading(false));
  }

  useEffect(() => {
    listOrganizations().then(setOrganizations).catch(() => setOrganizations([]));
    loadAccounts();
    listAllWorkspacesAdmin().then(setAllWorkspaces).catch(() => setAllWorkspaces([]));
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

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>System Admin</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close system admin">×</button>
        </div>
        <div style={styles.subtitle}>Create accounts, disable/enable access, and review every workspace across every organization.</div>

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
                <th style={styles.th}>Username</th>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>System admin</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.userId}>
                  <td style={styles.td}>{a.username}</td>
                  <td style={styles.td}>{a.email}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.statusBadge, color: a.status === 'DISABLED' ? '#c0392b' : 'var(--brg)' }}>
                      {a.status}
                    </span>
                  </td>
                  <td style={styles.td}>{a.isSystemAdmin ? 'Yes' : ''}</td>
                  <td style={styles.td}>
                    {/* Disabled for the caller's own row, mirroring the
                        backend's self-disable 400 — avoids a
                        guaranteed-failing click. */}
                    {a.status === 'DISABLED' ? (
                      <button type="button" style={styles.rowButton} onClick={() => handleEnable(a.userId)}>
                        Enable
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={styles.rowButton}
                        disabled={a.userId === user?.id}
                        onClick={() => handleDisable(a.userId)}
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
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
              </tr>
            </thead>
            <tbody>
              {allWorkspaces.map((ws) => (
                <tr key={ws.id}>
                  <td style={styles.td}>{ws.name}</td>
                  <td style={styles.td}>{ws.ownerUsername}</td>
                  <td style={styles.td}>{ws.organizationName}</td>
                  <td style={styles.td}>{ws.visibility}</td>
                  <td style={styles.td}>{ws.archivedAt ? 'Yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
