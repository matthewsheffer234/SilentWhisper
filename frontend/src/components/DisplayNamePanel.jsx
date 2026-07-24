import { useState } from 'react';
import Sheet from './Sheet.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// FEATURE_REQUEST.md's "display names settable in the admin account-creation
// worksheet" entry: closes the gap where a system admin could set a display
// name once at account-creation time (SystemAdminPanel's create-user form)
// but the account holder themselves had no way to ever change it. Same
// Sheet/placement pattern as ChangePasswordPanel.jsx — reachable from every
// user's own "Display Name" control (WorkspaceSidebar), not admin-gated.
//
// FEATURE_REQUEST.md entry 2: extended with a second, independent field for
// the per-user DM auto-archive threshold, reached from the same user-menu
// entry point rather than a new Sheet of its own — both are the same class
// of personal, cosmetic self-service preference.

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
  help: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginTop: 4 },
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
  const { user, setDisplayName, setDmSettings } = useAuth();
  const [name, setName] = useState(user?.displayName || '');
  // Blank means "no override — falls back to the system default"; the
  // backend never reports that state as anything other than null, and there
  // is no way to clear an override back to null once one is saved (matches
  // PATCH /api/auth/me/dm-settings, which always requires an explicit
  // integer).
  const initialArchiveInput = user?.dmAutoArchiveDays != null ? String(user.dmAutoArchiveDays) : '';
  const [archiveInput, setArchiveInput] = useState(initialArchiveInput);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const nameDirty = name !== (user?.displayName || '');
  const archiveDirty = archiveInput !== initialArchiveInput;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (nameDirty) {
        await setDisplayName(name);
      }
      if (archiveDirty && archiveInput !== '') {
        await setDmSettings(Number(archiveInput));
      }
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Failed to save changes');
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
      isDirty={nameDirty || archiveDirty}
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

        <div style={styles.field}>
          <label style={styles.label} htmlFor="dm-auto-archive-input">
            Auto-archive direct messages after ___ days (0 = never)
          </label>
          <input
            id="dm-auto-archive-input"
            type="number"
            min={0}
            step={1}
            style={styles.input}
            value={archiveInput}
            placeholder={`Default: ${user?.dmAutoArchiveDefaultDays ?? 90}`}
            onChange={(e) => setArchiveInput(e.target.value)}
          />
          <div style={styles.help}>
            Direct messages and group DMs with no activity for this long quietly drop out of your
            sidebar — they&apos;re never deleted, and a new message brings them right back.
          </div>
        </div>

        <button type="submit" style={styles.saveButton} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={styles.saved}>Saved</span>}
      </form>
    </Sheet>
  );
}
