import { useState } from 'react';
import Sheet from './Sheet.jsx';

// FEATURE_REQUEST.md's "confirmation and recovery for destructive or
// high-impact actions" entry: a shared primitive so every irreversible or
// security-impacting action (archive, remove member, revoke invitation,
// transfer ownership, password reset, account disable) gets the same
// specific-object-name-and-consequence confirmation, rather than each call
// site hand-rolling its own. Built on Sheet.jsx — same backdrop/focus-trap/
// Escape-to-close/return-focus behavior every other panel already has,
// Escape/backdrop-click here is exactly "Cancel" (isDirty is never set, so
// no extra confirm-to-cancel prompt stacks on top of this one).
// `onConfirm` is expected to perform the real action and may reject with a
// real Error (apiFetch's convention) — its message is shown inline and the
// dialog stays open so the user isn't left wondering whether it happened; a
// cancelled dialog never calls onConfirm, so nothing is audited for it.
const styles = {
  message: { fontSize: 'var(--text-sm)', color: 'var(--text-1)', marginBottom: 16, lineHeight: 1.5 },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  cancelButton: {
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  dangerButton: {
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: 'none',
    background: '#c0392b',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  confirmButton: {
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
};

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onClose,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message || 'Action failed');
      setSubmitting(false);
    }
  }

  return (
    <Sheet title={title} ariaLabel={title} onClose={onClose} width={420}>
      <div style={styles.message}>{message}</div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.actions}>
        <button type="button" style={styles.cancelButton} onClick={onClose} disabled={submitting}>
          {cancelLabel}
        </button>
        <button
          type="button"
          style={tone === 'danger' ? styles.dangerButton : styles.confirmButton}
          onClick={handleConfirm}
          disabled={submitting}
        >
          {submitting ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}
