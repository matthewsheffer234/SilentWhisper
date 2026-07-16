import { useState } from 'react';
import Sheet from './Sheet.jsx';

// Mirrors backend/src/validation.js's MAX_NAME_LENGTH (workspaces.name /
// channels.name are both VARCHAR(100)) — client-side inline validation
// only, the backend's own assertName remains the actual enforcement.
const MAX_NAME_LENGTH = 100;

// FEATURE_REQUEST.md's "focused creation sheets for workspaces and
// channels" entry: replaces WorkspaceSidebar.jsx's inline "+ New workspace"
// form (name + a single visibility checkbox squeezed into a sidebar row)
// with a real sheet that has room for an explanation of the consequence of
// each visibility choice, not just a tooltip.

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
  select: {
    fontSize: 'var(--text-base)',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    minHeight: 44,
  },
  visibilityOption: (active) => ({
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
  visibilityLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-1)' },
  visibilityExplain: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginLeft: 24 },
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

const VISIBILITY_OPTIONS = [
  { value: 'PRIVATE', label: 'Invite-only', explain: 'Only people you invite can join.' },
  { value: 'DISCOVERABLE', label: 'Listed', explain: 'Anyone in your organization can join without an invitation.' },
];

export default function CreateWorkspaceSheet({ organizations, selectedOrganizationId, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('PRIVATE');
  const [organizationId, setOrganizationId] = useState(selectedOrganizationId ?? organizations[0]?.id ?? '');
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
      await onCreate(trimmed, visibility, organizations.length > 1 ? organizationId : undefined);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create workspace');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      title="Create Workspace"
      onClose={onClose}
      width={440}
      isDirty={trimmed.length > 0}
    >
      {error && <div style={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="new-workspace-name">Workspace name</label>
          <input
            id="new-workspace-name"
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

        {organizations.length > 1 && (
          <div style={styles.field}>
            <label style={styles.label} htmlFor="new-workspace-org">Organization</label>
            <select
              id="new-workspace-org"
              style={styles.select}
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>
        )}

        <div style={styles.field}>
          <span style={styles.label}>Who can join</span>
          {VISIBILITY_OPTIONS.map((opt) => (
            <label key={opt.value} style={styles.visibilityOption(visibility === opt.value)}>
              <span style={styles.visibilityLabel}>
                <input
                  type="radio"
                  name="workspace-visibility"
                  checked={visibility === opt.value}
                  onChange={() => setVisibility(opt.value)}
                />
                {opt.label}
              </span>
              <span style={styles.visibilityExplain}>{opt.explain}</span>
            </label>
          ))}
        </div>

        <div style={styles.actions}>
          <button type="submit" style={styles.submitButton} disabled={submitting || !trimmed || Boolean(nameError)}>
            {submitting ? 'Creating…' : 'Create Workspace'}
          </button>
          <button type="button" style={styles.cancelButton} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
