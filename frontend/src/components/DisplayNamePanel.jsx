import { useState } from 'react';
import Sheet from './Sheet.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// FEATURE_REQUEST.md's "display names settable in the admin account-creation
// worksheet" entry: closes the gap where a system admin could set a display
// name once at account-creation time (SystemAdminPanel's create-user form)
// but the account holder themselves had no way to ever change it. Same
// Sheet/placement pattern as ChangePasswordPanel.jsx — reachable from every
// user's own "Display Name" control (WorkspaceSidebar), not admin-gated.

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

export default function DisplayNamePanel({ onClose }) {
  const { user, setDisplayName } = useAuth();
  const [name, setName] = useState(user?.displayName || '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setDisplayName(name);
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Failed to update display name');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      title="Display Name"
      ariaLabel="display name"
      subtitle="This is how your name appears to others in messages, mentions, and rosters."
      onClose={onClose}
      width={380}
      isDirty={name !== (user?.displayName || '')}
    >
      {error && <div style={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="display-name-input">Display name</label>
          <input
            id="display-name-input"
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <button type="submit" style={styles.saveButton} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={styles.saved}>Saved</span>}
      </form>
    </Sheet>
  );
}
