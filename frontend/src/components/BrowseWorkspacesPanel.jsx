import { useEffect, useState } from 'react';
import { listDiscoverableWorkspaces, subscribeToWorkspace } from '../api/workspaces.js';

// Self-service workspace subscription (FEATURE_REQUEST.md): the discover +
// join half of the feature, mirroring how PUBLIC channels already work.
// Modal shell copied from AuditDashboard.jsx's pattern rather than
// reinvented — same backdrop/panel/header/close-button styling.

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
    width: 480,
    maxWidth: '94vw',
    maxHeight: '86vh',
    display: 'flex',
    flexDirection: 'column',
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
  subtitle: { fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 12 },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  listWrap: { flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderTop: '1px solid var(--border)',
    minHeight: 44,
  },
  rowFirst: { borderTop: 'none' },
  name: { flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  subscribeButton: {
    minHeight: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--brg)',
    background: 'none',
    color: 'var(--brg)',
    fontWeight: 600,
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
  empty: { padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
};

export default function BrowseWorkspacesPanel({ onClose, onSubscribed }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subscribingId, setSubscribingId] = useState(null);

  useEffect(() => {
    listDiscoverableWorkspaces()
      .then(setRows)
      .catch((err) => setError(err.message || 'Failed to load discoverable workspaces'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubscribe(workspaceId) {
    setSubscribingId(workspaceId);
    setError(null);
    try {
      const workspace = await subscribeToWorkspace(workspaceId);
      setRows((prev) => prev.filter((ws) => ws.id !== workspaceId));
      onSubscribed(workspace);
    } catch (err) {
      setError(err.message || 'Failed to join workspace');
    } finally {
      setSubscribingId(null);
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Browse workspaces</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close browse workspaces">×</button>
        </div>
        <div style={styles.subtitle}>Public workspaces you're not already a member of.</div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.listWrap}>
          {loading ? (
            <div style={styles.empty}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={styles.empty}>No public workspaces to join right now.</div>
          ) : (
            rows.map((ws, i) => (
              <div key={ws.id} style={{ ...styles.row, ...(i === 0 ? styles.rowFirst : {}) }}>
                <span style={styles.name}>{ws.name}</span>
                <button
                  type="button"
                  style={styles.subscribeButton}
                  disabled={subscribingId === ws.id}
                  onClick={() => handleSubscribe(ws.id)}
                  aria-label={`Subscribe to ${ws.name}`}
                >
                  {subscribingId === ws.id ? 'Joining…' : 'Subscribe'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
