import { useState } from 'react';
import Sheet from './Sheet.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { searchOrgMembers } from '../api/organizations.js';

// FEATURE_REQUEST.md entry 3 (Direct Messages as a first-class navigation
// section): "New message flow — add a 'New Message' action using the
// people picker. One selected person creates/opens a direct DM; multiple
// selected people create a group DM." Candidate pool is the caller's
// currently-selected organization's roster (searchOrgMembers, plain-member
// gated) — DMs are workspace-independent, so this deliberately does not
// scope to the currently-selected workspace's members-search instead.
const styles = {
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  label: { fontSize: 'var(--text-xs)', color: 'var(--text-2)', fontWeight: 600 },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
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
  cancelButton: {
    minHeight: 44,
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-base)',
    cursor: 'pointer',
  },
};

export default function NewMessageSheet({ organizationId, onCreate, onClose }) {
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (people.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate(people.map((p) => p.userId));
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to start conversation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet title="New Message" onClose={onClose} width={440} isDirty={people.length > 0}>
      {error && <div style={styles.error}>{error}</div>}
      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="new-message-people">To</label>
          <PeoplePicker
            mode="multi"
            searchFn={(q) => searchOrgMembers(organizationId, q)}
            value={people}
            onChange={setPeople}
            placeholder="Search people by name or username"
            ariaLabel="Search people to message"
          />
        </div>
        <div style={styles.actions}>
          <button type="submit" style={styles.submitButton} disabled={submitting || people.length === 0}>
            {submitting ? 'Starting…' : people.length > 1 ? 'Start Group Message' : 'Start Message'}
          </button>
          <button type="button" style={styles.cancelButton} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
