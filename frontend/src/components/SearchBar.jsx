import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchSemantic } from '../api/search.js';

// FEATURE_REQUEST.md's Apple HIG UI/UX overhaul entry: replaces the
// "Search" button + full-modal SemanticSearchPanel entry point with a
// persistent field docked at the top of the sidebar — HIG's convention for
// search over a list/navigation column (visible immediately, not gated
// behind an extra click). The backend call (searchSemantic) and the result
// shape/navigation are unchanged from that shipped feature; only the
// presentation moves from a full backdrop modal to an anchored popover.
//
// Debounced, not live-as-you-type on every keystroke: every query is a real
// network round trip through an embedding call, gated by
// embeddingConcurrencyGate/semanticSearchRateLimiter (30/5min/user) —
// true live search would burn that budget on every partial word typed.
// Enter forces an immediate search, bypassing the debounce, for a user who
// already knows what they want.
const DEBOUNCE_MS = 450;
const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 8;

const styles = {
  wrap: { position: 'relative', padding: '10px 14px', borderBottom: '1px solid var(--border)' },
  fieldWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  icon: {
    position: 'absolute',
    left: 10,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    color: 'var(--text-3)',
    pointerEvents: 'none',
  },
  input: {
    width: '100%',
    minHeight: 40,
    padding: '0 30px 0 30px',
    borderRadius: 20,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  clearButton: {
    position: 'absolute',
    right: 4,
    minWidth: 32,
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-sm)',
  },
  popover: {
    position: 'absolute',
    top: '100%',
    left: 14,
    right: 14,
    marginTop: 6,
    maxHeight: 360,
    overflowY: 'auto',
    background: 'var(--overlay-bg)',
    boxShadow: 'var(--overlay-shadow)',
    border: '1px solid var(--border)',
    borderRadius: 11,
    zIndex: 40,
  },
  status: { padding: '14px 12px', textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--text-xs)' },
  error: { padding: '14px 12px', textAlign: 'center', color: '#c0392b', fontSize: 'var(--text-xs)' },
  narrowRow: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border)' },
  chip: (active) => ({
    minHeight: 26,
    padding: '2px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--brg)' : 'var(--border)'}`,
    background: active ? 'var(--brg-dim)' : 'transparent',
    color: active ? 'var(--brg)' : 'var(--text-3)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
  }),
  result: (highlighted) => ({
    padding: '8px 12px',
    cursor: 'pointer',
    background: highlighted ? 'var(--item-hover)' : 'transparent',
  }),
  resultHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  resultChannel: { fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  resultMeta: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', flexShrink: 0 },
  resultExcerpt: { fontSize: 'var(--text-xs)', color: 'var(--text-2)', marginTop: 2 },
  resultThreadNote: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginTop: 2, fontStyle: 'italic' },
};

export default function SearchBar({ onNavigate }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [narrowChannelId, setNarrowChannelId] = useState(null);
  const [narrowOptions, setNarrowOptions] = useState([]);
  const [dismissed, setDismissed] = useState(true);

  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Outside-click dismiss, same reliable pattern Menu.jsx uses — avoids the
  // classic combobox "blur fires before the result's click lands" footgun
  // that a bare onBlur handler would hit.
  useEffect(() => {
    if (dismissed) return undefined;
    function handlePointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) setDismissed(true);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [dismissed]);

  async function runSearch(trimmedQuery, channelIdOverride) {
    const effectiveChannelId = channelIdOverride !== undefined ? channelIdOverride : narrowChannelId;
    setLoading(true);
    setError(null);
    try {
      const { results: hits } = await searchSemantic({
        query: trimmedQuery,
        channelId: effectiveChannelId || undefined,
        limit: RESULT_LIMIT,
      });
      setResults(hits);
      setHighlightedIndex(-1);
      if (!effectiveChannelId) {
        const distinct = [...new Map(hits.map((h) => [h.channelId, h.channelName])).entries()];
        setNarrowOptions(distinct.length >= 3 ? distinct.map(([id, name]) => ({ id, name })) : []);
      }
    } catch (err) {
      setError(err.message || 'Search failed');
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  function scheduleSearch(value, { immediate = false, channelId } = {}) {
    clearTimeout(timerRef.current);
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setNarrowOptions([]);
      return;
    }
    if (immediate) {
      runSearch(trimmed, channelId);
    } else {
      timerRef.current = setTimeout(() => runSearch(trimmed, channelId), DEBOUNCE_MS);
    }
  }

  function handleChange(e) {
    const value = e.target.value;
    setQuery(value);
    setDismissed(false);
    scheduleSearch(value);
  }

  function handleClear() {
    clearTimeout(timerRef.current);
    setQuery('');
    setResults(null);
    setNarrowOptions([]);
    setNarrowChannelId(null);
    setDismissed(true);
    inputRef.current?.focus();
  }

  function handleNarrow(channelId) {
    setNarrowChannelId(channelId);
    scheduleSearch(query, { immediate: true, channelId });
  }

  function handleNavigate(hit) {
    onNavigate(hit);
    clearTimeout(timerRef.current);
    setQuery('');
    setResults(null);
    setNarrowOptions([]);
    setNarrowChannelId(null);
    setDismissed(true);
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results || results.length === 0) return;
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return prev === -1 ? 0 : (prev + delta + results.length) % results.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex !== -1 && results?.[highlightedIndex]) {
        handleNavigate(results[highlightedIndex]);
        return;
      }
      scheduleSearch(query, { immediate: true });
      return;
    }
    if (e.key === 'Escape') {
      // Checks whether the popover is actually showing right now, not
      // whether a search has resolved yet — pressing Escape while a search
      // is still debounce-pending (results still null, loading still
      // false) must still count as "dismiss," not fall through to clearing
      // the whole query outright. A real bug caught by testing: the
      // original condition (results !== null || loading) was false during
      // that pending window, so a fast Escape-right-after-typing cleared
      // the field on the first press instead of just closing the popover.
      if (popoverVisible) {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      handleClear();
    }
  }

  const popoverVisible = !dismissed && query.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div style={styles.wrap} ref={wrapRef}>
      <div style={styles.fieldWrap}>
        <span style={styles.icon} aria-hidden="true">
          <Search size={16} />
        </span>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          onChange={handleChange}
          onFocus={() => setDismissed(false)}
          onKeyDown={handleKeyDown}
          placeholder="Search messages"
          aria-label="Search messages"
          role="combobox"
          aria-expanded={popoverVisible}
          aria-haspopup="listbox"
        />
        {query.length > 0 && (
          <button type="button" style={styles.clearButton} onClick={handleClear} aria-label="Clear search">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {popoverVisible && (
        <div style={styles.popover} role="listbox" aria-label="Search results">
          {narrowOptions.length > 0 && (
            <div style={styles.narrowRow}>
              <button type="button" style={styles.chip(!narrowChannelId)} onClick={() => handleNarrow(null)}>
                Everywhere
              </button>
              {narrowOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.id}
                  style={styles.chip(narrowChannelId === opt.id)}
                  onClick={() => handleNarrow(opt.id)}
                >
                  {opt.name}
                </button>
              ))}
            </div>
          )}

          {loading && <div style={styles.status}>Searching…</div>}
          {error && <div style={styles.error}>{error}</div>}
          {!loading && !error && results && results.length === 0 && (
            <div style={styles.status}>No matching messages found.</div>
          )}
          {!loading &&
            results?.map((hit, index) => (
              <div
                key={hit.messageId}
                className="sl-row"
                role="option"
                aria-selected={index === highlightedIndex}
                style={styles.result(index === highlightedIndex)}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => handleNavigate(hit)}
              >
                <div style={styles.resultHead}>
                  <span style={styles.resultChannel}>{hit.channelName} · {hit.displayName || hit.username}</span>
                  <span style={styles.resultMeta}>{new Date(hit.createdAt).toLocaleDateString()}</span>
                </div>
                <div style={styles.resultExcerpt}>{hit.excerpt}</div>
                {hit.parentMessage && (
                  <div style={styles.resultThreadNote}>
                    Reply to {hit.parentMessage.displayName || hit.parentMessage.username}: "{hit.parentMessage.content}"
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
