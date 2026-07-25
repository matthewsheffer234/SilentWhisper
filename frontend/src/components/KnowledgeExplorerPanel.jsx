import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import Pager from './Pager.jsx';
import { listTrendingEntities } from '../api/entities.js';

// FEATURE_REQUEST.md entry 2: workspace-scoped Knowledge Explorer for the
// [[Entity]] graph. Phase 1 of the entry's design — the Trending Entities
// list; clicking a row opens the existing EntityDetailsPanel.jsx exactly as
// clicking an inline [[Entity]] mention already does via handleOpenEntity
// (ChatShell.jsx), now carrying that panel's own SME section and
// onViewContext addition.

const TRENDING_PAGE_SIZE = 20;

// Same row/keyboard-activation shape as WorkspaceSidebar.jsx's own
// activateOnKey — not shared cross-file (no such helper is exported today),
// duplicated here rather than introducing a new shared module for one line.
function activateOnKey(handler) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}

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
    cursor: 'pointer',
  },
  rowFirst: { borderTop: 'none' },
  name: { flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  count: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  empty: { padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
};

export default function KnowledgeExplorerPanel({ workspaceId, onOpenEntity, onClose }) {
  const [entities, setEntities] = useState([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  function loadTrending(nextOffset = 0) {
    setLoading(true);
    setError(null);
    listTrendingEntities(workspaceId, { limit: TRENDING_PAGE_SIZE, offset: nextOffset })
      .then((res) => {
        setEntities(res.entities);
        setOffset(res.offset);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message || 'Failed to load trending entities'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadTrending(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  return (
    <Sheet
      title="Knowledge Explorer"
      ariaLabel="Knowledge Explorer"
      subtitle="Trending entities across every channel you're a member of."
      onClose={onClose}
      width={620}
      maxHeight="86vh"
    >
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.listWrap}>
        {loading ? (
          <div style={styles.empty}>Loading…</div>
        ) : entities.length === 0 ? (
          <div style={styles.empty}>No entity activity in this window yet.</div>
        ) : (
          entities.map((entity, i) => (
            <div
              key={entity.id}
              className="sl-row"
              role="button"
              tabIndex={0}
              style={{ ...styles.row, ...(i === 0 ? styles.rowFirst : {}) }}
              onClick={() => onOpenEntity(entity)}
              onKeyDown={activateOnKey(() => onOpenEntity(entity))}
            >
              <span style={styles.name}>{entity.canonicalName}</span>
              <span style={styles.count}>
                {entity.referenceCount} reference{entity.referenceCount === 1 ? '' : 's'}
              </span>
            </div>
          ))
        )}
      </div>
      <Pager offset={offset} limit={TRENDING_PAGE_SIZE} total={total} onPageChange={loadTrending} />
    </Sheet>
  );
}
