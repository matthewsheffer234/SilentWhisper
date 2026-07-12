import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

// FEATURE_REQUEST.md: self-service password change — previously the only
// way to change any account's password was a direct database update. Same
// modal shape as AiSettingsPanel/AuditDashboard (backdrop/panel/header/
// title/44px closeButton/subtitle), reachable from every user's own
// "Change Password" control (WorkspaceSidebar), not admin-gated.

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
    width: 380,
    maxWidth: '92vw',
    background: 'var(--surface)',
    borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
    padding: '20px 24px',
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
  saveButton: {
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
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  saved: { color: 'var(--brg)', fontSize: 'var(--text-sm)', marginLeft: 12 },
};

export default function ChangePasswordPanel({ onClose }) {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await changePassword({ currentPassword, newPassword });
      setSaved(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Change Password</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close change password">×</button>
        </div>
        <div style={styles.subtitle}>Update the password for your own account.</div>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              style={styles.input}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              style={styles.input}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" style={styles.saveButton} disabled={saving}>
            {saving ? 'Saving…' : 'Change password'}
          </button>
          {saved && <span style={styles.saved}>Saved</span>}
        </form>
      </div>
    </div>
  );
}
