// Shared prev/next controls for offset-paginated list endpoints
// ({items, total, limit, offset} shape) — originally introduced in
// SystemAdminPanel.jsx for FEATURE_REQUEST.md entry 4's admin lists, lifted
// out here so FEATURE_REQUEST.md entry 2's newly-paginated member/roster
// panels can reuse the identical "Showing 1-50 of 340" UX instead of each
// re-implementing it.
const styles = {
  pager: { display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 4px' },
  pagerButton: {
    minWidth: 44,
    minHeight: 44,
    padding: '0 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
  pagerLabel: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
};

export default function Pager({ offset, limit, total, onPageChange }) {
  if (total === 0) return null;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;
  return (
    <div style={styles.pager}>
      <button
        type="button"
        style={{ ...styles.pagerButton, opacity: canPrev ? 1 : 0.4 }}
        disabled={!canPrev}
        onClick={() => onPageChange(Math.max(0, offset - limit))}
      >
        Prev
      </button>
      <span style={styles.pagerLabel}>
        Showing {start}-{end} of {total}
      </span>
      <button
        type="button"
        style={{ ...styles.pagerButton, opacity: canNext ? 1 : 0.4 }}
        disabled={!canNext}
        onClick={() => onPageChange(offset + limit)}
      >
        Next
      </button>
    </div>
  );
}
