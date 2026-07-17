import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, Hash, Lock, Sparkles, Info, User, Users, MessageSquare, ChevronDown } from 'lucide-react';
import PresenceBadge from './PresenceBadge.jsx';
import Menu from './Menu.jsx';
import { summarizeChannel } from '../api/ai.js';
import { searchChannelMembers } from '../api/workspaces.js';
import { searchEntities } from '../api/entities.js';
import { renderMessageContent } from '../markdown.jsx';
import { AI_SUMMARY_LIMIT, AI_SUMMARY_SCOPE, formatAiActionError } from '../aiPresentation.js';

// FEATURE_REQUEST.md's @mention autocomplete entry.
const AUTOCOMPLETE_DEBOUNCE_MS = 200;

// FEATURE_REQUEST.md entry 3 (message presentation for team scanability).
// Pure, DOM-free so they're unit-testable the same way ThemeContext.jsx's
// resolveTheme() is — see ChannelView.test.jsx.
export function isFirstInRun(messages, index) {
  const prev = messages[index - 1];
  return !prev || prev.userId !== messages[index].userId;
}

export function formatReplyCount(count) {
  // Deliberately the full phrase, not a bare "Reply", when there's nothing
  // to report yet — ThreadSidebar.jsx's own reply-composer submit button is
  // also just "Reply", and a message with no replies is the common case, so
  // a bare "Reply" launcher would collide with it both visually (in a
  // shared reply flow) and for `:text-is("Reply")`-style selectors/AT name
  // lookups. Compacting to a count only kicks in once there's an actual
  // count to show.
  if (!count) return 'Reply in thread';
  return `${count} ${count === 1 ? 'reply' : 'replies'}`;
}

export function initials(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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
  headerMeta: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)', fontWeight: 400, color: 'var(--text-3)' },
  headerActions: { display: 'flex', alignItems: 'center', gap: 6 },
  detailsButton: {
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    borderRadius: 8,
  },
  // 44px minimum height on every standalone tap target, per PROJECT_PLAN.md
  // Section 7 (Apple HIG Alignment) and the Phase 5 accessibility pass that
  // caught this row of toolbar-style buttons rendering well under it.
  aiMenuButton: {
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--brg)',
    background: 'none',
    border: '1px solid var(--brg)',
    borderRadius: 999,
    padding: '0 16px',
    cursor: 'pointer',
  },
  menuItemLabel: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  menuItemTitle: { fontWeight: 600, color: 'var(--text-1)' },
  menuItemDescription: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
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
  summaryScope: {
    marginBottom: 8,
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
  },
  feed: { flex: 1, overflowY: 'auto', padding: '16px 20px', position: 'relative' },
  feedInner: { position: 'relative', width: '100%' },
  // FEATURE_REQUEST.md's iMessage-style bubble layout entry: an outer
  // alignment container (the virtualizer's own position/measurement target
  // — unchanged) wrapping an inner bubble, not a single flat div. The outer
  // row is mostly empty alignment space once split, so `className="sl-row"`
  // (global.css's `.sl-row:hover{background:var(--item-hover)}`) moves onto
  // the bubble itself — hovering the empty alignment space shouldn't
  // highlight anything.
  messageRowOuter: { display: 'flex', width: '100%', gap: 8 },
  messageBubble: {
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '60%',
    borderRadius: 16,
    padding: '8px 12px',
    boxSizing: 'border-box',
  },
  // Channels have no mirrored "mine" bubble competing for space on the
  // other side, so they get more breathing room than a DM's 60%.
  messageBubbleChannel: { maxWidth: '75%' },
  // Fixed-width slot so a message's text always starts at the same x
  // position whether or not this particular row shows an avatar — the
  // same alignment trick Slack/Apple Messages both use for grouped runs.
  avatarSlot: { width: 28, flexShrink: 0, display: 'flex', justifyContent: 'center' },
  avatarCircle: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    border: '1px solid var(--border)',
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    flexShrink: 0,
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
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
  suggestionDropdown: {
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
  suggestionOption: (highlighted) => ({
    minHeight: 36,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    background: highlighted ? 'var(--item-hover)' : 'transparent',
  }),
  suggestionSecondary: { color: 'var(--text-3)', fontSize: 'var(--text-xs)' },
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

export default function ChannelView({
  channel,
  messages,
  presence,
  currentUser,
  joined,
  archived,
  onSend,
  onOpenThread,
  onOpenDetails,
  onOpenEntity,
  workspaceId,
  mainContentId,
}) {
  const [draft, setDraft] = useState('');
  const feedRef = useRef(null);
  const [summary, setSummary] = useState(null); // { loading, text, error, scope }

  // @mention autocomplete (FEATURE_REQUEST.md). One object rather than
  // several separate useState calls — start/query/suggestions/highlightIndex
  // all change together on every keystroke, and splitting them invites a
  // stale-read race between a debounced fetch's callback and a newer
  // keystroke.
  const [mention, setMention] = useState(null); // { start, query, suggestions, highlightIndex } | null
  const [entity, setEntity] = useState(null); // { start, query, suggestions, highlightIndex } | null
  const composerInputRef = useRef(null);
  const mentionDropdownRef = useRef(null);
  const entityDropdownRef = useRef(null);
  const mentionDebounceRef = useRef(null);
  const entityDebounceRef = useRef(null);
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

  useEffect(
    () => () => {
      clearTimeout(mentionDebounceRef.current);
      clearTimeout(entityDebounceRef.current);
    },
    [],
  );

  // Outside-click dismiss, same pattern as SearchBar.jsx/Menu.jsx — a bare
  // onBlur would fire before a mousedown-driven suggestion click lands.
  useEffect(() => {
    if (!mention && !entity) return undefined;
    function handlePointerDown(e) {
      if (
        composerInputRef.current?.contains(e.target) ||
        mentionDropdownRef.current?.contains(e.target) ||
        entityDropdownRef.current?.contains(e.target)
      ) {
        return;
      }
      setMention(null);
      setEntity(null);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [mention, entity]);

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
    setEntity(null);
  }, [channel?.id]);

  if (!channel) {
    return (
      <div id={mainContentId} tabIndex={-1} style={styles.wrapper}>
        <div style={styles.empty}>Select a channel to get started.</div>
      </div>
    );
  }

  // FEATURE_REQUEST.md entry 3 (Direct Messages navigation): "Header copy
  // should reflect people, not #channel." DIRECT/GROUP_DM channels have no
  // workspace-scoped membership-management surface (ChannelDetailsPanel
  // talks to a workspace-scoped members endpoint), so the details button is
  // channel/private-channel-only — Summarize stays available for DMs too,
  // since the backend's summarize route is channel-generic.
  const isDirectConversation = channel.type === 'DIRECT' || channel.type === 'GROUP_DM';

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

  function detectEntityTrigger(text, caretPos) {
    let i = caretPos - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '\n' || ch === ']') return null;
      if (ch === '[' && i > 0 && text[i - 1] === '[') {
        const query = text.slice(i + 1, caretPos);
        if (query.length > 255 || /[\[\]]/.test(query)) return null;
        return { start: i - 1, query };
      }
      i -= 1;
    }
    return null;
  }

  function handleComposerChange(e) {
    const value = e.target.value;
    const caretPos = e.target.selectionStart;
    setDraft(value);

    const mentionTrigger = detectMentionTrigger(value, caretPos);
    const entityTrigger = !isDirectConversation && workspaceId ? detectEntityTrigger(value, caretPos) : null;
    const useEntity = entityTrigger && (!mentionTrigger || entityTrigger.start > mentionTrigger.start);
    const trigger = useEntity ? entityTrigger : mentionTrigger;

    clearTimeout(mentionDebounceRef.current);
    clearTimeout(entityDebounceRef.current);
    if (!trigger) {
      setMention(null);
      setEntity(null);
      return;
    }
    if (useEntity) {
      setMention(null);
      setEntity((prev) => ({
        start: trigger.start,
        query: trigger.query,
        suggestions: prev && prev.start === trigger.start ? prev.suggestions : [],
        highlightIndex: -1,
      }));
      entityDebounceRef.current = setTimeout(async () => {
        try {
          const results = await searchEntities(workspaceId, trigger.query);
          setEntity((prev) =>
            prev && prev.start === trigger.start && prev.query === trigger.query
              ? { ...prev, suggestions: results, highlightIndex: results.length > 0 ? 0 : -1 }
              : prev,
          );
        } catch {
          setEntity((prev) => (prev && prev.start === trigger.start ? { ...prev, suggestions: [], highlightIndex: -1 } : prev));
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);
      return;
    }
    setEntity(null);
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
    }, AUTOCOMPLETE_DEBOUNCE_MS);
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

  function acceptEntitySuggestion(canonicalName) {
    if (!entity) return;
    const before = draft.slice(0, entity.start);
    const after = draft.slice(entity.start + 2 + entity.query.length);
    const insertion = `[[${canonicalName}]] `;
    pendingCaretRef.current = before.length + insertion.length;
    setDraft(`${before}${insertion}${after}`);
    setEntity(null);
  }

  function handleComposerKeyDown(e) {
    const activeKind = entity && entity.suggestions.length > 0 ? 'entity' : mention && mention.suggestions.length > 0 ? 'mention' : null;
    if (activeKind) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const setter = activeKind === 'entity' ? setEntity : setMention;
        setter((prev) => {
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const next = (prev.highlightIndex + delta + prev.suggestions.length) % prev.suggestions.length;
          return { ...prev, highlightIndex: next };
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // preventDefault is what stops Enter from also submitting the form.
        e.preventDefault();
        if (activeKind === 'entity') {
          const chosen = entity.suggestions[entity.highlightIndex] ?? entity.suggestions[0];
          if (chosen) acceptEntitySuggestion(chosen.canonicalName);
        } else {
          const chosen = mention.suggestions[mention.highlightIndex] ?? mention.suggestions[0];
          if (chosen) acceptMentionSuggestion(chosen.username);
        }
        return;
      }
    }
    if (e.key === 'Escape' && (mention || entity)) {
      e.preventDefault();
      setMention(null);
      setEntity(null);
    }
  }

  async function handleSummarize() {
    setSummary({ loading: true, text: '', error: null, scope: AI_SUMMARY_SCOPE });
    try {
      await summarizeChannel(
        channel.id,
        (chunk) => {
          setSummary((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
        },
        { limit: AI_SUMMARY_LIMIT },
      );
      setSummary((prev) => (prev ? { ...prev, loading: false } : prev));
    } catch (err) {
      setSummary({ loading: false, text: '', error: formatAiActionError(err, 'Failed to summarize recent messages'), scope: AI_SUMMARY_SCOPE });
    }
  }

  const aiMenuItems = [
    {
      key: 'summarize-recent-messages',
      label: (
        <span style={styles.menuItemLabel}>
          <span style={styles.menuItemTitle}>Summarize Recent Messages</span>
          <span style={styles.menuItemDescription}>{AI_SUMMARY_SCOPE}</span>
        </span>
      ),
      onSelect: handleSummarize,
      disabled: summary?.loading,
    },
  ];

  return (
    <div id={mainContentId} tabIndex={-1} style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>
          {isDirectConversation ? (
            channel.type === 'GROUP_DM' ? <Users size={16} aria-hidden="true" /> : <User size={16} aria-hidden="true" />
          ) : channel.type === 'PRIVATE' ? (
            <Lock size={16} aria-hidden="true" />
          ) : (
            <Hash size={16} aria-hidden="true" />
          )}
          {channel.name}
          <span style={styles.headerMeta}>
            {isDirectConversation
              ? channel.type === 'GROUP_DM'
                ? `${channel.memberCount} people`
                : 'Direct message'
              : channel.type === 'PRIVATE'
                ? 'Private'
                : 'Open'}
            {!isDirectConversation &&
              typeof channel.memberCount === 'number' &&
              ` · ${channel.memberCount} member${channel.memberCount === 1 ? '' : 's'}`}
            {archived && ' · archived — read only'}
          </span>
        </span>
        <span style={styles.headerActions}>
          <Menu
            ariaLabel="AI actions"
            items={aiMenuItems}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.aiMenuButton} aria-label="AI actions">
                <Sparkles size={14} aria-hidden="true" />
                <span>{summary?.loading ? 'Running AI…' : 'AI Actions'}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
          />
          {!isDirectConversation && (
            <button type="button" style={styles.detailsButton} onClick={onOpenDetails} aria-label={`${channel.name} channel details`}>
              <Info size={18} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {summary && (
        <div style={styles.summaryPanel}>
          <div style={styles.summaryPanelHeader}>
            <span>Summary</span>
            <button type="button" style={styles.summaryClose} onClick={() => setSummary(null)} aria-label="Close summary">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div style={styles.summaryScope}>{summary.scope}</div>
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
            // Only DMs/group-DMs use the mine/theirs bubble split — channels
            // render every message with the same "theirs" visual treatment
            // regardless of sender (FEATURE_REQUEST.md entry 3's resolved
            // alignment call). `isMine` itself is still needed above for
            // things unrelated to color/alignment (none currently), so it's
            // kept as a separate variable rather than folded away.
            const useMineStyle = isDirectConversation && isMine;
            // Consecutive-message grouping: tighten the gap *after* this row
            // when the next message in the (already chronologically ordered)
            // array shares the same sender, rather than repeating full row
            // spacing for every message in a run.
            const nextMessage = messages[virtualRow.index + 1];
            const isGroupedWithNext = Boolean(nextMessage && nextMessage.userId === m.userId);
            // DMs keep "never show my own name" regardless of grouping;
            // channels show the author (including the current user's own
            // name) only at the start of a same-sender run.
            const showAuthor = isDirectConversation ? !isMine : isFirstInRun(messages, virtualRow.index);
            const showAvatar = !isDirectConversation && showAuthor;
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
                  justifyContent: useMineStyle ? 'flex-end' : 'flex-start',
                  paddingBottom: isGroupedWithNext ? 2 : 10,
                  ...(m.pending ? styles.pending : {}),
                }}
              >
                {!isDirectConversation && (
                  <div style={styles.avatarSlot}>
                    {showAvatar && <div className="sl-avatar" style={styles.avatarCircle}>{initials(m.displayName || m.username)}</div>}
                  </div>
                )}
                <div
                  className={`sl-row sl-bubble-${useMineStyle ? 'mine' : 'theirs'}`}
                  style={{
                    ...styles.messageBubble,
                    ...(isDirectConversation ? {} : styles.messageBubbleChannel),
                    ...(useMineStyle ? styles.messageBubbleMine : styles.messageBubbleTheirs),
                  }}
                >
                  <div style={{ ...styles.messageMeta, ...(useMineStyle ? styles.messageMetaMine : {}) }}>
                    {showAuthor && <span style={styles.messageAuthor}>{m.displayName || m.username}</span>}
                    <PresenceBadge status={presence[m.userId] ?? 'offline'} variant={useMineStyle ? 'onMine' : undefined} />
                    <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={styles.messageContent}>
                    {renderMessageContent(m.content, { variant: useMineStyle ? 'mine' : undefined, onEntityClick: onOpenEntity })}
                  </div>
                  {!m.parentMessageId && !m.pending && (
                    <button
                      type="button"
                      style={{ ...styles.replyButton, ...(useMineStyle ? styles.replyButtonMine : {}) }}
                      onClick={() => onOpenThread(m)}
                      aria-label={m.replyCount ? `Reply in thread, ${formatReplyCount(m.replyCount)}` : undefined}
                    >
                      <MessageSquare size={12} aria-hidden="true" />
                      {formatReplyCount(m.replyCount ?? 0)}
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
            placeholder={
              archived
                ? 'This workspace is archived — read only'
                : joined
                  ? `Message ${isDirectConversation ? channel.name : `#${channel.name}`}`
                  : 'Joining channel…'
            }
            disabled={!joined || archived}
            maxLength={10000}
            role="combobox"
            aria-expanded={Boolean((mention && mention.suggestions.length > 0) || (entity && entity.suggestions.length > 0))}
            aria-controls={entity && entity.suggestions.length > 0 ? 'entity-suggestions' : 'mention-suggestions'}
            aria-autocomplete="list"
            aria-activedescendant={
              entity && entity.highlightIndex >= 0
                ? `entity-option-${entity.suggestions[entity.highlightIndex].id}`
                : mention && mention.highlightIndex >= 0
                  ? `mention-option-${mention.suggestions[mention.highlightIndex].id}`
                  : undefined
            }
          />
          {entity && entity.suggestions.length > 0 && (
            <div
              ref={entityDropdownRef}
              id="entity-suggestions"
              role="listbox"
              aria-label="Entity suggestions"
              style={styles.suggestionDropdown}
            >
              {entity.suggestions.map((s, index) => (
                <div
                  key={s.id}
                  id={`entity-option-${s.id}`}
                  role="option"
                  aria-selected={index === entity.highlightIndex}
                  style={styles.suggestionOption(index === entity.highlightIndex)}
                  onMouseEnter={() => setEntity((prev) => (prev ? { ...prev, highlightIndex: index } : prev))}
                  onClick={() => acceptEntitySuggestion(s.canonicalName)}
                >
                  <span>{s.canonicalName}</span>
                  {s.description && <span style={styles.suggestionSecondary}>{s.description}</span>}
                </div>
              ))}
            </div>
          )}
          {mention && mention.suggestions.length > 0 && (
            <div
              ref={mentionDropdownRef}
              id="mention-suggestions"
              role="listbox"
              aria-label="Mention suggestions"
              style={styles.suggestionDropdown}
            >
              {mention.suggestions.map((s, index) => (
                <div
                  key={s.id}
                  id={`mention-option-${s.id}`}
                  role="option"
                  aria-selected={index === mention.highlightIndex}
                  style={styles.suggestionOption(index === mention.highlightIndex)}
                  onMouseEnter={() => setMention((prev) => (prev ? { ...prev, highlightIndex: index } : prev))}
                  onClick={() => acceptMentionSuggestion(s.username)}
                >
                  <span>{s.displayName || s.username}</span>
                  <span style={styles.suggestionSecondary}>@{s.username}</span>
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
