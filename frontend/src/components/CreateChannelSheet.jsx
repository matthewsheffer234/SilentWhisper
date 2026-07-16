import { useState } from 'react';
import Sheet from './Sheet.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { searchWorkspaceMembers } from '../api/workspaces.js';

// FEATURE_REQUEST.md's "focused creation sheets for workspaces and
// channels" entry: replaces WorkspaceSidebar.jsx's inline "+ New channel"
// form with a sheet that has room for a privacy explanation and, for a
// private channel, an optional set of initial invitees via the people
// picker — none of which fit in the old single sidebar row.
const MAX_NAME_LENGTH = 100;

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
  privacyOption: (active) => ({
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--brg)' : 'var(--border)'}`,
    background: active ? 'var(--surface-alt)' : 'transparent',
    cursor: 'pointer',
    marginBottom: 8,
  }),
  privacyLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-1)' },
  privacyExplain: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginLeft: 24 },
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

const PRIVACY_OPTIONS = [
  { value: 'PUBLIC', label: 'Open', explain: 'Visible to the whole workspace; anyone can join.' },
  { value: 'PRIVATE', label: 'Private', explain: 'Visible only to invited members.' },
];

export default function CreateChannelSheet({ workspaceId, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('PUBLIC');
  const [initialInvitees, setInitialInvitees] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const nameError = trimmed.length === 0 ? null : trimmed.length > MAX_NAME_LENGTH ? `Name must be at most ${MAX_NAME_LENGTH} characters` : null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!trimmed || nameError) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate(
        trimmed,
        type,
        type === 'PRIVATE' ? initialInvitees.map((p) => p.username) : [],
      );
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create channel');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      title="Create Channel"
      onClose={onClose}
      width={440}
      isDirty={trimmed.length > 0 || initialInvitees.length > 0}
    >
      {error && <div style={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="new-channel-name">Channel name</label>
          <input
            id="new-channel-name"
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            // Deliberately no `maxLength` attribute here — that would
            // silently truncate typed/pasted input at the browser level,
            // making the over-length error message below unreachable. The
            // inline validation is the actual feedback mechanism.
            required
            autoFocus
          />
          {nameError && <span style={styles.error}>{nameError}</span>}
        </div>

        <div style={styles.field}>
          <span style={styles.label}>Privacy</span>
          {PRIVACY_OPTIONS.map((opt) => (
            <label key={opt.value} style={styles.privacyOption(type === opt.value)}>
              <span style={styles.privacyLabel}>
                <input type="radio" name="channel-privacy" checked={type === opt.value} onChange={() => setType(opt.value)} />
                {opt.label}
              </span>
              <span style={styles.privacyExplain}>{opt.explain}</span>
            </label>
          ))}
        </div>

        {type === 'PRIVATE' && (
          <div style={styles.field}>
            <label style={styles.label} htmlFor="new-channel-invitees">Add people (optional)</label>
            <PeoplePicker
              mode="multi"
              searchFn={(q) => searchWorkspaceMembers(workspaceId, q)}
              value={initialInvitees}
              onChange={setInitialInvitees}
              placeholder="Search workspace members to invite"
              ariaLabel="Search workspace members to invite to new channel"
            />
          </div>
        )}

        <div style={styles.actions}>
          <button type="submit" style={styles.submitButton} disabled={submitting || !trimmed || Boolean(nameError)}>
            {submitting ? 'Creating…' : 'Create Channel'}
          </button>
          <button type="button" style={styles.cancelButton} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
