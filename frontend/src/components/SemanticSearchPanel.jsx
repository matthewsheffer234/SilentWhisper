import { useState } from 'react';
import { searchSemantic } from '../api/search.js';

// FEATURE_REQUEST.md entry 1: "add a semantic search surface ... The input
// should invite conceptual queries, but results must be presented as
// message/channel hits with clear timestamps and navigation into the
// original thread/channel context." Same modal pattern as
// AiSettingsPanel.jsx/AuditDashboard.jsx (backdrop + centered panel, 44px
// tap targets, no transition/animation). Available to every user, not
// admin-gated — unlike AI Settings, search is a normal-member feature.

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
    width: 640,
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
  form: { display: 'flex', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    minHeight: 44,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  select: {
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    maxWidth: 180,
  },
  submitButton: {
    minHeight: 44,
    padding: '0 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  resultsWrap: { flex: 1, overflowY: 'auto' },
  empty: { padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
  result: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    marginBottom: 8,
    cursor: 'pointer',
  },
  resultHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  resultChannel: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)' },
  resultMeta: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  resultExcerpt: { fontSize: 'var(--text-sm)', color: 'var(--text-2)' },
  resultThreadNote: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginTop: 4, fontStyle: 'italic' },
};

// Standard, recognizable "press Enter/click Search" combobox-adjacent
// pattern (PROJECT_PLAN.md Section 7) — not live-as-you-type: this is a
// conceptual query box, a materially different interaction than the
// @mention autocomplete's caret-anchored partial-token matching.
export default function SemanticSearchPanel({ workspaces, currentWorkspaceId, onClose, onNavigate }) {
  const [query, setQuery] = useState('');
  const [scopeWorkspaceId, setScopeWorkspaceId] = useState(currentWorkspaceId ?? '');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { results: hits } = await searchSemantic({
        query,
        workspaceId: scopeWorkspaceId || undefined,
      });
      setResults(hits);
    } catch (err) {
      setError(err.message || 'Search failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Search</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close search">×</button>
        </div>
        <div style={styles.subtitle}>Ask a conceptual question — results are ranked by meaning, not exact wording.</div>

        <form style={styles.form} onSubmit={handleSubmit}>
          <input
            style={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What are you looking for?"
            aria-label="Search query"
            autoFocus
          />
          <select
            style={styles.select}
            value={scopeWorkspaceId}
            onChange={(e) => setScopeWorkspaceId(e.target.value)}
            aria-label="Search scope"
          >
            <option value="">All my workspaces</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
          <button type="submit" style={styles.submitButton} disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.resultsWrap} aria-label="Search results">
          {results && results.length === 0 && <div style={styles.empty}>No matching messages found.</div>}
          {results &&
            results.map((hit) => (
              <div
                key={hit.messageId}
                className="sl-row"
                style={styles.result}
                role="button"
                tabIndex={0}
                onClick={() => onNavigate(hit)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onNavigate(hit);
                  }
                }}
              >
                <div style={styles.resultHead}>
                  <span style={styles.resultChannel}>
                    {hit.channelName} · {hit.username}
                  </span>
                  <span style={styles.resultMeta}>{new Date(hit.createdAt).toLocaleString()}</span>
                </div>
                <div style={styles.resultExcerpt}>{hit.excerpt}</div>
                {hit.parentMessage && (
                  <div style={styles.resultThreadNote}>Reply to {hit.parentMessage.username}: "{hit.parentMessage.content}"</div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
