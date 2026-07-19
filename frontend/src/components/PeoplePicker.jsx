import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

// FEATURE_REQUEST.md's "unified people picker" entry: one reusable
// search-and-select control for every "add a person" flow (workspace
// member add, private-channel invite, ownership transfer, organization
// member add), replacing brittle exact-username text inputs. Debounce/
// outside-click-dismiss/keyboard-nav pattern mirrors SearchBar.jsx and
// ChannelView.jsx's mention-autocomplete dropdown — the established
// convention in this codebase for this class of control — but the actual
// search call is injected via `searchFn` so this component owns no
// knowledge of which scope (workspace/channel/org) it's searching.
//
// `searchFn(query)` resolves an array of
// `{ userId, username, displayName, email, ...eligibility flags }`.
// `isIneligible(person)` returns a short reason string to disable a row
// (e.g. "Already a member") or null/undefined if selectable — this is how
// callers wire alreadyMember/alreadyInChannel/isSelf into the UI without
// PeoplePicker needing to know those field names itself.
const DEBOUNCE_MS = 200;

const styles = {
  wrap: { position: 'relative' },
  chipsRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    padding: '2px 6px 2px 10px',
    borderRadius: 999,
    border: '1px solid var(--brg)',
    background: 'var(--brg-dim, transparent)',
    color: 'var(--brg)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
  },
  chipRemove: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 22,
    minHeight: 22,
    borderRadius: '50%',
    border: 'none',
    background: 'none',
    color: 'inherit',
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    maxHeight: 240,
    overflowY: 'auto',
    background: 'var(--overlay-bg)',
    boxShadow: 'var(--overlay-shadow)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    zIndex: 60,
  },
  status: { padding: '10px 12px', fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  error: { padding: '10px 12px', fontSize: 'var(--text-xs)', color: '#c0392b' },
  option: (highlighted, disabled) => ({
    display: 'flex',
    flexDirection: 'column',
    padding: '8px 12px',
    cursor: disabled ? 'default' : 'pointer',
    background: highlighted && !disabled ? 'var(--item-hover)' : 'transparent',
    opacity: disabled ? 0.55 : 1,
  }),
  optionName: { fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  optionSecondary: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
};

// Exported for unit testing (no jsdom in this project's Vitest setup — see
// ChannelView.test.jsx — so this pure helper is tested directly rather than
// through a rendered component). FEATURE_REQUEST.md entry 1: members-search
// no longer returns email, so callers backed by that endpoint need a
// non-blank secondary line; people-search-backed callers still have email
// and keep showing it.
export function personSecondaryLabel(person, reason) {
  return reason || person.email || `@${person.username}`;
}

function PersonLabel({ person }) {
  const name = person.displayName || person.username;
  const showUsername = person.displayName && person.displayName !== person.username;
  return (
    <>
      {name}
      {showUsername && <span> @{person.username}</span>}
    </>
  );
}

export default function PeoplePicker({
  searchFn,
  mode = 'single',
  value,
  onChange,
  placeholder = 'Search by name, username, or email',
  ariaLabel = 'Search people',
  isIneligible,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [open, setOpen] = useState(false);

  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  // Guards against a real race: focus fires an immediate search with
  // whatever `query` was at that instant (often '', since focus lands
  // before a fill/keystroke updates it), while a subsequent keystroke
  // schedules its own debounced search for the new value. Nothing enforces
  // response order — if the empty-query request resolves after the typed
  // one, its unfiltered results would silently clobber the correct filtered
  // ones. Each search call captures the current sequence number; a response
  // is only applied if it's still the most recently issued one.
  const requestSeqRef = useRef(0);
  // Real bug found by e2e testing, not by inspection: selecting a person in
  // multi-select mode refocuses the input (so the user can immediately type
  // to add another) — but that programmatic .focus() fires the same onFocus
  // handler a real user's click would, which unconditionally reopened the
  // dropdown showing stale results. Since the dropdown is `position:
  // absolute`, it doesn't push page content down — it floats over whatever
  // sits below the picker, which for both new call sites (channel-creation
  // sheet) is the submit button, silently blocking it until the user clicked
  // away first. Suppresses exactly the one focus event caused by that
  // specific refocus, not real focus events from an actual click/Tab.
  const suppressNextFocusOpenRef = useRef(false);

  const selectedList = mode === 'multi' ? (value ?? []) : value ? [value] : [];
  const selectedIds = new Set(selectedList.map((p) => p.userId));

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  async function runSearch(q) {
    const seq = (requestSeqRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const rows = await searchFn(q);
      if (seq !== requestSeqRef.current) return; // a newer search superseded this one
      setResults(rows.filter((r) => !selectedIds.has(r.userId)));
      setHighlightedIndex(-1);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err.message || 'Search failed');
      setResults(null);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }

  function scheduleSearch(q) {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS);
  }

  function handleChange(e) {
    const next = e.target.value;
    setQuery(next);
    setOpen(true);
    scheduleSearch(next);
  }

  function handleFocus() {
    if (suppressNextFocusOpenRef.current) {
      suppressNextFocusOpenRef.current = false;
      return;
    }
    setOpen(true);
    if (results === null) runSearch(query);
  }

  function selectPerson(person) {
    if (isIneligible?.(person)) return;
    if (mode === 'multi') {
      onChange([...(value ?? []), person]);
      setQuery('');
      setOpen(false);
      setResults(null);
      suppressNextFocusOpenRef.current = true;
    } else {
      onChange(person);
      setQuery('');
      setOpen(false);
    }
    inputRef.current?.focus();
  }

  function removePerson(userId) {
    if (mode === 'multi') {
      onChange((value ?? []).filter((p) => p.userId !== userId));
    } else {
      onChange(null);
    }
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
        selectPerson(results[highlightedIndex]);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
    if (e.key === 'Backspace' && query === '' && mode === 'multi' && selectedList.length > 0) {
      removePerson(selectedList[selectedList.length - 1].userId);
    }
  }

  // Single-select with a person already chosen: show the chip in place of
  // the search input, matching the "recognizable person chip" behavior the
  // design calls for rather than leaving a redundant empty search field
  // visible alongside the selection.
  if (mode === 'single' && value) {
    return (
      <div style={styles.chipsRow}>
        <span style={styles.chip}>
          <PersonLabel person={value} />
          <button
            type="button"
            style={styles.chipRemove}
            onClick={() => removePerson(value.userId)}
            aria-label={`Remove ${value.displayName || value.username}`}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div style={styles.wrap} ref={wrapRef}>
      {mode === 'multi' && selectedList.length > 0 && (
        <div style={styles.chipsRow}>
          {selectedList.map((person) => (
            <span key={person.userId} style={styles.chip}>
              <PersonLabel person={person} />
              <button
                type="button"
                style={styles.chipRemove}
                onClick={() => removePerson(person.userId)}
                aria-label={`Remove ${person.displayName || person.username}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        style={styles.input}
        value={query}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
      />
      {open && (
        <div style={styles.dropdown} role="listbox" aria-label={ariaLabel}>
          {loading && <div style={styles.status}>Searching…</div>}
          {error && <div style={styles.error}>{error}</div>}
          {!loading && !error && results && results.length === 0 && (
            <div style={styles.status}>No matching people found.</div>
          )}
          {!loading &&
            results?.map((person, index) => {
              const reason = isIneligible?.(person);
              return (
                <div
                  key={person.userId}
                  className="sl-row"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  aria-disabled={Boolean(reason)}
                  style={styles.option(index === highlightedIndex, Boolean(reason))}
                  onMouseEnter={() => !reason && setHighlightedIndex(index)}
                  onClick={() => selectPerson(person)}
                >
                  <span style={styles.optionName}>
                    <PersonLabel person={person} />
                  </span>
                  <span style={styles.optionSecondary}>{personSecondaryLabel(person, reason)}</span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
