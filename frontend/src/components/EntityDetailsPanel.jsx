import { useEffect, useState } from 'react';
import { Hash } from 'lucide-react';
import Sheet from './Sheet.jsx';
import { getEntity, listEntityReferences } from '../api/entities.js';
import { renderMessageContent } from '../markdown.jsx';

const styles = {
  sectionTitle: {
    marginTop: 14,
    marginBottom: 8,
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  description: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    whiteSpace: 'pre-wrap',
  },
  aliases: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  alias: {
    padding: '3px 8px',
    borderRadius: 999,
    background: 'var(--surface-alt)',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
  },
  references: { display: 'flex', flexDirection: 'column', gap: 10 },
  reference: {
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
  },
  referenceMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    color: 'var(--text-3)',
    fontSize: 'var(--text-xs)',
  },
  referenceContent: { color: 'var(--text-1)', fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  muted: { color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)' },
  loadMore: {
    minHeight: 40,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    fontWeight: 600,
  },
};

export default function EntityDetailsPanel({ workspaceId, entityId, initialEntity, onClose }) {
  const [entity, setEntity] = useState(initialEntity ?? null);
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getEntity(workspaceId, entityId), listEntityReferences(workspaceId, entityId, { limit: 20 })])
      .then(([details, refs]) => {
        if (cancelled) return;
        setEntity(details);
        setReferences(refs);
        setHasMore(refs.length === 20);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load entity');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, entityId]);

  async function loadMore() {
    const last = references[references.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const more = await listEntityReferences(workspaceId, entityId, { limit: 20, before: last.createdAt });
      setReferences((prev) => [...prev, ...more]);
      setHasMore(more.length === 20);
    } catch (err) {
      setError(err.message || 'Failed to load references');
    } finally {
      setLoadingMore(false);
    }
  }

  const title = entity?.canonicalName ?? initialEntity?.canonicalName ?? 'Entity';

  return (
    <Sheet ariaLabel={`${title} entity details`} title={title} subtitle="Entity profile" onClose={onClose} width={620} maxHeight="86vh">
      {loading && <div style={styles.muted}>Loading entity…</div>}
      {error && <div style={styles.error}>{error}</div>}
      {entity && !loading && (
        <>
          <div style={styles.sectionTitle}>Summary</div>
          <div style={styles.description}>{entity.description || 'No description yet.'}</div>
          {entity.aliases?.length > 0 && (
            <>
              <div style={styles.sectionTitle}>Aliases</div>
              <div style={styles.aliases}>
                {entity.aliases.map((alias) => (
                  <span key={alias} style={styles.alias}>{alias}</span>
                ))}
              </div>
            </>
          )}
          <div style={styles.sectionTitle}>{entity.referenceCount} reference{entity.referenceCount === 1 ? '' : 's'}</div>
          <div style={styles.references}>
            {references.length === 0 && <div style={styles.muted}>No visible references.</div>}
            {references.map((ref) => (
              <div key={ref.messageId} style={styles.reference}>
                <div style={styles.referenceMeta}>
                  <Hash size={12} aria-hidden="true" />
                  <span>{ref.channelName}</span>
                  <span>·</span>
                  <span>{ref.displayName || ref.username}</span>
                  <span>·</span>
                  <span>{new Date(ref.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
                <div style={styles.referenceContent}>{renderMessageContent(ref.content)}</div>
              </div>
            ))}
            {hasMore && (
              <button type="button" style={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
