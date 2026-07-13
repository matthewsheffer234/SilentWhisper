import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import PresenceBadge from './PresenceBadge.jsx';
import { summarizeChannel } from '../api/ai.js';
import { searchChannelMembers } from '../api/workspaces.js';
import { renderMessageContent } from '../markdown.jsx';

// FEATURE_REQUEST.md's @mention autocomplete entry.
const MENTION_DEBOUNCE_MS = 200;

const styles = {
  wrapper: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface)' },
  header: {
    padding: '14px 20px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 'var(--text-md)',
    fontWeight: 700,
    color: 'var(--text-1)',
  },
  headerTitle: { display: 'flex', alignItems: 'center', gap: 8 },
  // 44px minimum height on every standalone tap target, per PROJECT_PLAN.md
  // Section 7 (Apple HIG Alignment) and the Phase 5 accessibility pass that
  // caught this row of toolbar-style buttons rendering well under it.
  summarizeButton: {
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--brg)',
    background: 'none',
    border: '1px solid var(--brg)',
    borderRadius: 999,
    padding: '0 16px',
    cursor: 'pointer',
  },
  summaryPanel: {
    margin: '12px 20px 0',
    padding: '12px 16px',
    borderRadius: 10,
    background: 'var(--surface-alt)',
    boxShadow: 'var(--input-shadow)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    whiteSpace: 'pre-wrap',
  },
  summaryPanelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  summaryClose: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-md)',
  },
  summaryError: { color: '#c0392b' },
  feed: { flex: 1, overflowY: 'auto', padding: '16px 20px', position: 'relative' },
  feedInner: { position: 'relative', width: '100%' },
  // FEATURE_REQUEST.md's iMessage-style bubble layout entry: an outer
  // alignment container (the virtualizer's own position/measurement target
  // — unchanged) wrapping an inner bubble, not a single flat div. The outer
  // row is mostly empty alignment space once split, so `className="sl-row"`
  // (global.css's `.sl-row:hover{background:var(--item-hover)}`) moves onto
  // the bubble itself — hovering the empty alignment space shouldn't
  // highlight anything.
  messageRowOuter: { display: 'flex', width: '100%' },
  messageBubble: {
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '60%',
    borderRadius: 16,
    padding: '8px 12px',
    boxSizing: 'border-box',
  },
  // Reuses the exact token pair `--item-active-bg`/`--item-active-fg`
  // already established for the active sidebar row (PROJECT_PLAN.md
  // Section 7: "do not introduce a second accent color... under different
  // names") — not a new "filled colored surface" convention invented here.
  messageBubbleMine: { background: 'var(--brg)', color: 'var(--item-active-fg)' },
  messageBubbleTheirs: { background: 'var(--surface-alt)', color: 'var(--text-1)' },
  messageMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  // Overrides messageMeta's fixed gray — without this, the timestamp/
  // presence-badge row would stay gray-on-green inside a "mine" bubble,
  // the same contrast problem markdown.jsx's mention/link fix addresses,
  // just for this metadata row instead of message content.
  messageMetaMine: { color: 'var(--item-active-fg)' },
  messageAuthor: { fontWeight: 700, color: 'var(--text-1)' },
  messageContent: { fontSize: 'var(--text-base)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  pending: { opacity: 0.55 },
  replyButton: {
    alignSelf: 'flex-start',
    fontSize: 'var(--text-xs)',
    color: 'var(--brg)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    marginTop: 2,
  },
  // Same green-on-green problem as mentions/links/the meta row — "Reply in
  // thread"'s text color is the bubble's own fill color inside "mine".
  replyButtonMine: { color: 'var(--item-active-fg)', textDecoration: 'underline' },
  composer: { display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)' },
  composerInputWrap: { position: 'relative', flex: 1 },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    boxShadow: 'var(--input-shadow)',
    fontSize: 'var(--text-base)',
    boxSizing: 'border-box',
  },
  // Anchored *above* the input (bottom: 100%) rather than below it, same as
  // every other composer-adjacent popover in a bottom-docked chat input —
  // opening downward would push it off the viewport.
  mentionDropdown: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 6,
    maxHeight: 220,
    overflowY: 'auto',
    background: 'var(--overlay-bg)',
    boxShadow: 'var(--overlay-shadow)',
    border: '1px solid var(--border)',
    borderRadius: 11,
    zIndex: 40,
  },
  mentionOption: (highlighted) => ({
    minHeight: 36,
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    background: highlighted ? 'var(--item-hover)' : 'transparent',
  }),
  sendButton: {
    minHeight: 44,
    padding: '0 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: '20px 0' },
};

export default function ChannelView({ channel, messages, presence, currentUser, joined, archived, onSend, onOpenThread, mainContentId }) {
  const [draft, setDraft] = useState('');
  const feedRef = useRef(null);
  const [summary, setSummary] = useState(null); // { loading, text, error }

  // @mention autocomplete (FEATURE_REQUEST.md). One object rather than
  // several separate useState calls — start/query/suggestions/highlightIndex
  // all change together on every keystroke, and splitting them invites a
  // stale-read race between a debounced fetch's callback and a newer
  // keystroke.
  const [mention, setMention] = useState(null); // { start, query, suggestions, highlightIndex } | null
  const composerInputRef = useRef(null);
  const mentionDropdownRef = useRef(null);
  const mentionDebounceRef = useRef(null);
  const pendingCaretRef = useRef(null);

  // Repositions the caret after a programmatic draft replacement (accepting
  // a suggestion) — must run in the paint-blocking layout phase, same
  // pattern this session already used for other caret-after-replace cases,
  // otherwise the browser's own post-render caret placement wins the race.
  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null && composerInputRef.current) {
      composerInputRef.current.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  });

  useEffect(() => () => clearTimeout(mentionDebounceRef.current), []);

  // Outside-click dismiss, same pattern as SearchBar.jsx/Menu.jsx — a bare
  // onBlur would fire before a mousedown-driven suggestion click lands.
  useEffect(() => {
    if (!mention) return undefined;
    function handlePointerDown(e) {
      if (composerInputRef.current?.contains(e.target) || mentionDropdownRef.current?.contains(e.target)) return;
      setMention(null);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [mention]);

  // Windowed rendering (PROJECT_PLAN.md Section 8, Phase 5: "Add virtual
  // scrolling for long chat histories") — only the rows actually within (or
  // near) the visible viewport are mounted, regardless of how many thousands
  // of messages a channel's history holds. Row heights vary (wrapped message
  // text, the optional "Reply in thread" button), so this uses dynamic
  // measurement (`measureElement`) rather than a fixed row height, which
  // would either clip taller rows or leave excess gaps around shorter ones.
  const getScrollElement = useCallback(() => feedRef.current, []);
  const estimateSize = useCallback(() => 64, []);
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement,
    estimateSize,
    overscan: 8,
  });

  useEffect(() => {
    if (messages.length === 0) return;
    // Drives scrollTop directly against the real DOM scrollHeight rather
    // than the virtualizer's own scrollToIndex — scrollToIndex computes its
    // target offset from whatever row-height data it has *at the moment
    // it's called*, which on a freshly loaded channel is still
    // estimateSize's guess (64px) for rows that haven't been measured yet.
    // That guess is rarely exact (real rows run taller: three lines of text
    // plus padding), so the resulting position lands short of the actual
    // bottom and never gets corrected — observed settling well above the
    // last message on a real history, caught by the virtual-scrolling e2e
    // test rather than by eye (the gap is easy to miss on a short, mostly
    // single-line history). scrollHeight always reflects the *current*
    // total (estimated now, exact once ResizeObserver-driven measurement
    // catches up), so re-applying it across a couple of frames converges on
    // the real bottom regardless of measurement timing.
    let frame1;
    let frame2;
    const scrollToBottom = () => {
      const el = feedRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    scrollToBottom();
    frame1 = requestAnimationFrame(() => {
      scrollToBottom();
      frame2 = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
    // Only messages.length actually needs to trigger a re-scroll-to-bottom
    // (a new message arriving), not every reconciliation of an existing one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // A summary belongs to the channel it was generated for — close it out
  // when the user switches channels rather than leaving stale text visible
  // under a different channel's header.
  useEffect(() => {
    setSummary(null);
    setMention(null);
  }, [channel?.id]);

  if (!channel) {
    return (
      <div id={mainContentId} tabIndex={-1} style={styles.wrapper}>
        <div style={styles.empty}>Select a channel to get started.</div>
      </div>
    );
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft('');
  }

  // Scans backward from the caret for an in-progress "@token". Distinct from
  // markdown.jsx's rendering-side mention regex (which matches a *completed*
  // mention for display) — this matches a partial word still being typed,
  // and is anchored to the caret rather than scanning the whole string.
  function detectMentionTrigger(text, caretPos) {
    let i = caretPos - 1;
    while (i >= 0 && /[a-zA-Z0-9_.-]/.test(text[i])) i -= 1;
    if (i < 0 || text[i] !== '@') return null;
    if (i > 0 && /\S/.test(text[i - 1])) return null; // must start a word, e.g. not "email@x"
    return { start: i, query: text.slice(i + 1, caretPos) };
  }

  function handleComposerChange(e) {
    const value = e.target.value;
    const caretPos = e.target.selectionStart;
    setDraft(value);

    const trigger = detectMentionTrigger(value, caretPos);
    clearTimeout(mentionDebounceRef.current);
    if (!trigger) {
      setMention(null);
      return;
    }
    setMention((prev) => ({
      start: trigger.start,
      query: trigger.query,
      suggestions: prev && prev.start === trigger.start ? prev.suggestions : [],
      highlightIndex: -1,
    }));
    mentionDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchChannelMembers(channel.id, trigger.query);
        setMention((prev) =>
          prev && prev.start === trigger.start && prev.query === trigger.query
            ? { ...prev, suggestions: results, highlightIndex: results.length > 0 ? 0 : -1 }
            : prev,
        );
      } catch {
        // A failed lookup just means no suggestions right now — must never
        // block typing or surface an error in the composer.
        setMention((prev) => (prev && prev.start === trigger.start ? { ...prev, suggestions: [], highlightIndex: -1 } : prev));
      }
    }, MENTION_DEBOUNCE_MS);
  }

  function acceptMentionSuggestion(username) {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.start + 1 + mention.query.length);
    const insertion = `@${username} `;
    pendingCaretRef.current = before.length + insertion.length;
    setDraft(`${before}${insertion}${after}`);
    setMention(null);
  }

  function handleComposerKeyDown(e) {
    if (mention && mention.suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((prev) => {
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const next = (prev.highlightIndex + delta + prev.suggestions.length) % prev.suggestions.length;
          return { ...prev, highlightIndex: next };
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // preventDefault is what stops Enter from also submitting the form.
        e.preventDefault();
        const chosen = mention.suggestions[mention.highlightIndex] ?? mention.suggestions[0];
        if (chosen) acceptMentionSuggestion(chosen.username);
        return;
      }
    }
    if (e.key === 'Escape' && mention) {
      e.preventDefault();
      setMention(null);
    }
  }

  async function handleSummarize() {
    setSummary({ loading: true, text: '', error: null });
    try {
      await summarizeChannel(channel.id, (chunk) => {
        setSummary((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
      });
      setSummary((prev) => (prev ? { ...prev, loading: false } : prev));
    } catch (err) {
      setSummary({ loading: false, text: '', error: err.message || 'Failed to summarize channel' });
    }
  }

  return (
    <div id={mainContentId} tabIndex={-1} style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>{channel.type === 'PRIVATE' ? '🔒' : '#'} {channel.name}</span>
        <button type="button" style={styles.summarizeButton} onClick={handleSummarize} disabled={summary?.loading}>
          {summary?.loading ? 'Summarizing…' : 'Summarize'}
        </button>
      </div>
      {summary && (
        <div style={styles.summaryPanel}>
          <div style={styles.summaryPanelHeader}>
            <span>Channel summary</span>
            <button type="button" style={styles.summaryClose} onClick={() => setSummary(null)} aria-label="Close summary">×</button>
          </div>
          {summary.error ? (
            <div style={styles.summaryError}>{summary.error}</div>
          ) : (
            <div>{summary.text || (summary.loading ? 'Reading recent messages…' : '')}</div>
          )}
        </div>
      )}
      <div style={styles.feed} ref={feedRef}>
        {messages.length === 0 && <div style={styles.empty}>No messages yet — say hello.</div>}
        <div style={{ ...styles.feedInner, height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const m = messages[virtualRow.index];
            const isMine = m.userId === currentUser.id;
            // Consecutive-message grouping: tighten the gap *after* this row
            // when the next message in the (already chronologically ordered)
            // array shares the same sender, rather than repeating full row
            // spacing for every message in a run. Metadata (author/
            // timestamp) still renders on every row regardless — only the
            // spacing changes, per the design's explicit accessibility note
            // (hover/first-of-run-only metadata is excluded here on purpose).
            const nextMessage = messages[virtualRow.index + 1];
            const isGroupedWithNext = Boolean(nextMessage && nextMessage.userId === m.userId);
            return (
              <div
                key={m.id}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  ...styles.messageRowOuter,
                  justifyContent: isMine ? 'flex-end' : 'flex-start',
                  paddingBottom: isGroupedWithNext ? 2 : 10,
                  ...(m.pending ? styles.pending : {}),
                }}
              >
                <div
                  className={`sl-row sl-bubble-${isMine ? 'mine' : 'theirs'}`}
                  style={{
                    ...styles.messageBubble,
                    ...(isMine ? styles.messageBubbleMine : styles.messageBubbleTheirs),
                  }}
                >
                  <div style={{ ...styles.messageMeta, ...(isMine ? styles.messageMetaMine : {}) }}>
                    {!isMine && <span style={styles.messageAuthor}>{m.username}</span>}
                    <PresenceBadge status={presence[m.userId] ?? 'offline'} variant={isMine ? 'onMine' : undefined} />
                    <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={styles.messageContent}>
                    {renderMessageContent(m.content, { variant: isMine ? 'mine' : undefined })}
                  </div>
                  {!m.parentMessageId && !m.pending && (
                    <button
                      type="button"
                      style={{ ...styles.replyButton, ...(isMine ? styles.replyButtonMine : {}) }}
                      onClick={() => onOpenThread(m)}
                    >
                      Reply in thread
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <form style={styles.composer} onSubmit={handleSubmit}>
        <div style={styles.composerInputWrap}>
          <input
            ref={composerInputRef}
            style={styles.input}
            value={draft}
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            placeholder={archived ? 'This workspace is archived — read only' : joined ? `Message #${channel.name}` : 'Joining channel…'}
            disabled={!joined || archived}
            maxLength={10000}
            role="combobox"
            aria-expanded={Boolean(mention && mention.suggestions.length > 0)}
            aria-controls="mention-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={
              mention && mention.highlightIndex >= 0 ? `mention-option-${mention.suggestions[mention.highlightIndex].id}` : undefined
            }
          />
          {mention && mention.suggestions.length > 0 && (
            <div
              ref={mentionDropdownRef}
              id="mention-suggestions"
              role="listbox"
              aria-label="Mention suggestions"
              style={styles.mentionDropdown}
            >
              {mention.suggestions.map((s, index) => (
                <div
                  key={s.id}
                  id={`mention-option-${s.id}`}
                  role="option"
                  aria-selected={index === mention.highlightIndex}
                  style={styles.mentionOption(index === mention.highlightIndex)}
                  onMouseEnter={() => setMention((prev) => (prev ? { ...prev, highlightIndex: index } : prev))}
                  onClick={() => acceptMentionSuggestion(s.username)}
                >
                  @{s.username}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="submit" style={styles.sendButton} disabled={!joined || archived || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
