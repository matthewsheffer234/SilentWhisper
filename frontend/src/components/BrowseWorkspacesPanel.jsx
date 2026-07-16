import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import { listDiscoverableWorkspaces, subscribeToWorkspace } from '../api/workspaces.js';

// Self-service workspace subscription (FEATURE_REQUEST.md): the discover +
// join half of the feature, mirroring how PUBLIC channels already work.
// Uses the shared Sheet primitive (FEATURE_REQUEST.md's "standard
// modal/sheet component" entry).

const styles = {
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
  joinButton: {
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

export default function BrowseWorkspacesPanel({ onClose, onSubscribed, organizationId }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subscribingId, setSubscribingId] = useState(null);

  useEffect(() => {
    // organizationId (FEATURE_REQUEST.md entry 1, slice 3): required once an
    // account belongs to 2+ orgs — the backend 400s without it
    // (resolveCallerOrganization) — so this must track the org switcher's
    // current selection, not just default silently the way it could before
    // a second org could ever exist.
    listDiscoverableWorkspaces(organizationId)
      .then(setRows)
      .catch((err) => setError(err.message || 'Failed to load discoverable workspaces'))
      .finally(() => setLoading(false));
  }, [organizationId]);

  async function handleJoin(workspaceId) {
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
    <Sheet
      title="Join a workspace"
      ariaLabel="join a workspace"
      subtitle="Listed workspaces you can join. Anyone in your organization can join a listed workspace."
      onClose={onClose}
      width={480}
      maxHeight="86vh"
    >
        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.listWrap}>
          {loading ? (
            <div style={styles.empty}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={styles.empty}>No listed workspaces to join right now.</div>
          ) : (
            rows.map((ws, i) => (
              <div key={ws.id} style={{ ...styles.row, ...(i === 0 ? styles.rowFirst : {}) }}>
                <span style={styles.name}>{ws.name}</span>
                <button
                  type="button"
                  style={styles.joinButton}
                  disabled={subscribingId === ws.id}
                  onClick={() => handleJoin(ws.id)}
                  aria-label={`Join ${ws.name}`}
                >
                  {subscribingId === ws.id ? 'Joining…' : 'Join'}
                </button>
              </div>
            ))
          )}
        </div>
    </Sheet>
  );
}
