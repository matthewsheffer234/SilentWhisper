import { useState } from 'react';
import Sheet from './Sheet.jsx';

// FEATURE_REQUEST.md entry 1, slice 3. Uses the shared Sheet primitive
// (FEATURE_REQUEST.md's "standard modal/sheet component" entry). The
// trigger itself is already system-admin-gated (WorkspaceSidebar's org
// switcher), but the server call is the real enforcement, same convention as
// every other form here — a 403 here is possible in principle, shown inline
// like any other.

const styles = {
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  label: { fontSize: 'var(--text-xs)', color: 'var(--text-2)', fontWeight: 600 },
  input: {
    fontSize: 'var(--text-base)',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    minHeight: 44,
  },
  submitButton: {
    minHeight: 44,
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontSize: 'var(--text-base)',
    fontWeight: 600,
    cursor: 'pointer',
  },
};

export default function CreateOrganizationModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err.message || 'Failed to create organization');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      title="Create organization"
      subtitle="Organizations group workspaces under shared membership."
      onClose={onClose}
      width={420}
      isDirty={name.trim().length > 0}
    >
      {error && <div style={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="new-org-name">Organization name</label>
          <input
            id="new-org-name"
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <button type="submit" style={styles.submitButton} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create organization'}
        </button>
      </form>
    </Sheet>
  );
}
