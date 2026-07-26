import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Sparkles, ChevronDown } from 'lucide-react';
import { UserPresenceBadge } from '../context/PresenceContext.jsx';
import Menu from './Menu.jsx';
import { extractTasks } from '../api/ai.js';
import { searchChannelMembers } from '../api/workspaces.js';
import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  detectMentionTrigger,
  isFirstInRun,
  initials,
  EditableMessageContent,
  clampComposerHeight,
} from './ChannelView.jsx';
import { AI_THREAD_SCOPE, formatAiActionError, formatAiQueueLabel } from '../aiPresentation.js';

// Matches styles.input's minHeight: 40 below (single line); ~6 lines' worth
// beyond that before the composer scrolls internally, same reasoning as
// ChannelView.jsx's own composer, scaled to this sidebar's smaller input.
const COMPOSER_MIN_HEIGHT = 40;
const COMPOSER_MAX_HEIGHT = 150;

const styles = {
  sidebar: {
    width: 320,
    minWidth: 320,
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--border)',
    background: 'var(--surface-alt)',
  },
  header: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    color: 'var(--text-1)',
  },
  headerActions: { display: 'flex', alignItems: 'center', gap: 10 },
  // 44px minimum tap target height (PROJECT_PLAN.md Section 7) — this
  // sidebar header is visually compact, but the button itself still needs
  // the full hit area even though it doesn't need to look 44px tall.
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
    padding: '0 12px',
    cursor: 'pointer',
  },
  menuItemLabel: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  menuItemTitle: { fontWeight: 600, color: 'var(--text-1)' },
  menuItemDescription: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  taskPanel: {
    margin: '12px 16px 0',
    padding: '10px 12px',
    borderRadius: 10,
    background: 'var(--surface)',
    boxShadow: 'var(--input-shadow)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    whiteSpace: 'pre-wrap',
  },
  taskPanelHeader: {
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
  taskError: { color: '#c0392b' },
  taskScope: {
    marginBottom: 8,
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
  },
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
    fontSize: 'var(--text-md)',
  },
  root: { padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  // FEATURE_REQUEST.md's iMessage-style bubble layout entry: "extending the
  // same bubble treatment [to ThreadSidebar] is a natural, in-scope part of
  // 'the messaging window'" — same alignment/color/contrast rules as
  // ChannelView.jsx's message rows, not a separate visual language for
  // thread replies.
  rowOuter: { display: 'flex', width: '100%', gap: 8 },
  bubble: { display: 'flex', flexDirection: 'column', maxWidth: '80%', borderRadius: 14, padding: '7px 10px', boxSizing: 'border-box' },
  // Channel-origin threads get the same wider allowance ChannelView.jsx
  // gives its own non-DM messages, for the same reason (no mirrored "mine"
  // bubble on the other side to leave room for).
  bubbleChannel: { maxWidth: '92%' },
  bubbleMine: { background: 'var(--brg)', color: 'var(--item-active-fg)' },
  bubbleTheirs: { background: 'var(--surface)', color: 'var(--text-1)' },
  avatarSlot: { width: 24, flexShrink: 0, display: 'flex', justifyContent: 'center' },
  avatarCircle: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    border: '1px solid var(--border)',
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  bubbleMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  bubbleMetaMine: { color: 'var(--item-active-fg)' },
  bubbleAuthor: { fontWeight: 700, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  bubbleContent: { fontSize: 'var(--text-sm)', marginTop: 2, whiteSpace: 'pre-wrap' },
  // FEATURE_REQUEST.md entry 3 (message editing): same treatment as
  // ChannelView.jsx's own replyButton/replyButtonMine pair, for the
  // Edit/"(edited)" actions EditableMessageContent renders.
  actionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    color: 'var(--brg)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    marginTop: 2,
  },
  actionButtonMine: { color: 'var(--item-active-fg)', textDecoration: 'underline' },
  replies: { flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
  composer: { display: 'flex', gap: 6, padding: '12px 16px', borderTop: '1px solid var(--border)' },
  composerInputWrap: { position: 'relative', flex: 1 },
  input: {
    width: '100%',
    minHeight: 40,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
    // Auto-grow (FEATURE_REQUEST.md's Shift+Enter entry), same treatment as
    // ChannelView.jsx's own composer — see that file's styles.input.
    resize: 'none',
    overflowY: 'hidden',
    fontFamily: 'inherit',
    lineHeight: 1.4,
  },
  // Same up-anchored positioning as ChannelView.jsx's own suggestionDropdown
  // — this composer is bottom-docked inside the sidebar too, so opening
  // downward would push the list off the viewport.
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
    minHeight: 40,
    padding: '0 14px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
};

// Finding 7, docs/reviews/security-performance-review-2026-07-20.md:
// React.memo, no `presence` prop (see UserPresenceBadge above).
function ThreadSidebar({
  channelId,
  rootMessage,
  replies,
  currentUser,
  onSendReply,
  onClose,
  isDirectConversation,
  onOpenEntity,
  onToggleTask,
  taskOverrides,
  onEditMessage,
}) {
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState(null); // { loading, text, error, scope }

  // @mention autocomplete (FEATURE_REQUEST.md), mirroring ChannelView.jsx's
  // channel composer so the same "@" workflow is available when replying in
  // a thread. Shares detectMentionTrigger/AUTOCOMPLETE_DEBOUNCE_MS with that
  // file rather than forking the regex; no [[entity]] linking here since
  // that wasn't part of this ask and would need a workspaceId this sidebar
  // doesn't currently receive.
  const [mention, setMention] = useState(null); // { start, query, suggestions, highlightIndex } | null
  const composerInputRef = useRef(null);
  const mentionDropdownRef = useRef(null);
  const mentionDebounceRef = useRef(null);
  const pendingCaretRef = useRef(null);

  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null && composerInputRef.current) {
      composerInputRef.current.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  });

  // Auto-grow the reply composer to fit its content — see ChannelView.jsx's
  // own composer effect for why this runs on every draft change rather than
  // only onChange (accepting a suggestion and clearing on submit both need
  // it too).
  useLayoutEffect(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = clampComposerHeight(el.scrollHeight, COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => () => clearTimeout(mentionDebounceRef.current), []);

  // Outside-click dismiss, same pattern as ChannelView.jsx's composer — a
  // bare onBlur would fire before a mousedown-driven suggestion click lands.
  useEffect(() => {
    if (!mention) return undefined;
    function handlePointerDown(e) {
      if (composerInputRef.current?.contains(e.target) || mentionDropdownRef.current?.contains(e.target)) {
        return;
      }
      setMention(null);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [mention]);

  useEffect(() => {
    setTasks(null);
    setMention(null);
  }, [rootMessage?.id]);

  if (!rootMessage) return null;

  function submitDraft() {
    if (!draft.trim()) return;
    onSendReply(draft.trim());
    setDraft('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    submitDraft();
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
        const results = await searchChannelMembers(channelId, trigger.query);
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
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Shift+Enter falls through to the textarea's own native behavior —
      // inserting a newline at the caret — since nothing here calls
      // preventDefault() on it.
      e.preventDefault();
      submitDraft();
    }
  }

  async function handleExtractTasks() {
    setTasks({ loading: true, text: '', error: null, scope: AI_THREAD_SCOPE, queuePosition: null });
    try {
      await extractTasks(
        rootMessage.id,
        (chunk) => {
          setTasks((prev) => (prev ? { ...prev, text: prev.text + chunk, queuePosition: null } : prev));
        },
        { onQueued: (position) => setTasks((prev) => (prev ? { ...prev, queuePosition: position } : prev)) },
      );
      setTasks((prev) => (prev ? { ...prev, loading: false } : prev));
    } catch (err) {
      setTasks({ loading: false, text: '', error: formatAiActionError(err, 'Failed to find action items'), scope: AI_THREAD_SCOPE });
    }
  }

  const aiMenuItems = [
    {
      key: 'find-action-items',
      label: (
        <span style={styles.menuItemLabel}>
          <span style={styles.menuItemTitle}>Find Action Items</span>
          <span style={styles.menuItemDescription}>{AI_THREAD_SCOPE}</span>
        </span>
      ),
      onSelect: handleExtractTasks,
      disabled: tasks?.loading,
    },
  ];

  return (
    <aside style={styles.sidebar}>
      <div style={styles.header}>
        Thread
        <div style={styles.headerActions}>
          <Menu
            ariaLabel="Thread AI actions"
            items={aiMenuItems}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.aiMenuButton} aria-label="Thread AI actions">
                <Sparkles size={14} aria-hidden="true" />
                <span>{tasks?.loading ? (tasks.queuePosition ? formatAiQueueLabel(tasks.queuePosition) : 'Running AI…') : 'AI Actions'}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
          />
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close thread">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {tasks && (
        <div style={styles.taskPanel}>
          <div style={styles.taskPanelHeader}>
            <span>Action items</span>
            <button type="button" style={styles.closeButton} onClick={() => setTasks(null)} aria-label="Close action items">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div style={styles.taskScope}>{tasks.scope}</div>
          {tasks.error ? (
            <div style={styles.taskError}>{tasks.error}</div>
          ) : (
            <div>{tasks.text || (tasks.loading ? 'Reading this thread…' : '')}</div>
          )}
        </div>
      )}
      <div style={styles.root}>
        {(() => {
          const isMine = rootMessage.userId === currentUser.id;
          // The root message has no predecessor in this sidebar, so it's
          // always its own run — same "always show author" rule ChannelView
          // gives the first message of any run.
          const useMineStyle = isDirectConversation && isMine;
          const showAuthor = isDirectConversation ? !isMine : true;
          const showAvatar = !isDirectConversation;
          return (
            <div style={{ ...styles.rowOuter, justifyContent: useMineStyle ? 'flex-end' : 'flex-start' }}>
              {!isDirectConversation && (
                <div style={styles.avatarSlot}>
                  {showAvatar && (
                    <div className="sl-avatar" style={styles.avatarCircle}>
                      {initials(rootMessage.displayName || rootMessage.username)}
                    </div>
                  )}
                </div>
              )}
              <div
                className="sl-row"
                style={{
                  ...styles.bubble,
                  ...(isDirectConversation ? {} : styles.bubbleChannel),
                  ...(useMineStyle ? styles.bubbleMine : styles.bubbleTheirs),
                }}
              >
                <div style={{ ...styles.bubbleMeta, ...(useMineStyle ? styles.bubbleMetaMine : {}) }}>
                  {showAuthor && <span style={styles.bubbleAuthor}>{rootMessage.displayName || rootMessage.username}</span>}
                  <UserPresenceBadge userId={rootMessage.userId} variant={useMineStyle ? 'onMine' : undefined} />
                </div>
                <EditableMessageContent
                  message={rootMessage}
                  channelId={channelId}
                  canEdit={isMine && !rootMessage.pending}
                  onEditMessage={onEditMessage}
                  onEntityClick={onOpenEntity}
                  onToggleTask={onToggleTask}
                  taskOverrides={taskOverrides}
                  variant={useMineStyle ? 'mine' : undefined}
                  contentStyle={styles.bubbleContent}
                  actionButtonStyle={{ ...styles.actionButton, ...(useMineStyle ? styles.actionButtonMine : {}) }}
                />
              </div>
            </div>
          );
        })()}
      </div>
      <div style={styles.replies}>
        {replies.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>No replies yet.</div>}
        {replies.map((r, index) => {
          const isMine = r.userId === currentUser.id;
          const useMineStyle = isDirectConversation && isMine;
          const showAuthor = isDirectConversation ? !isMine : isFirstInRun(replies, index);
          const showAvatar = !isDirectConversation && showAuthor;
          return (
            <div key={r.id} style={{ ...styles.rowOuter, justifyContent: useMineStyle ? 'flex-end' : 'flex-start' }}>
              {!isDirectConversation && (
                <div style={styles.avatarSlot}>
                  {showAvatar && (
                    <div className="sl-avatar" style={styles.avatarCircle}>
                      {initials(r.displayName || r.username)}
                    </div>
                  )}
                </div>
              )}
              <div
                className="sl-row"
                style={{
                  ...styles.bubble,
                  ...(isDirectConversation ? {} : styles.bubbleChannel),
                  ...(useMineStyle ? styles.bubbleMine : styles.bubbleTheirs),
                }}
              >
                <div style={{ ...styles.bubbleMeta, ...(useMineStyle ? styles.bubbleMetaMine : {}) }}>
                  {showAuthor && <span style={styles.bubbleAuthor}>{r.displayName || r.username}</span>}
                  <UserPresenceBadge userId={r.userId} variant={useMineStyle ? 'onMine' : undefined} />
                </div>
                <EditableMessageContent
                  message={r}
                  channelId={channelId}
                  canEdit={isMine && !r.pending}
                  onEditMessage={onEditMessage}
                  onEntityClick={onOpenEntity}
                  onToggleTask={r.pending ? undefined : onToggleTask}
                  taskOverrides={taskOverrides}
                  variant={useMineStyle ? 'mine' : undefined}
                  contentStyle={styles.bubbleContent}
                  actionButtonStyle={{ ...styles.actionButton, ...(useMineStyle ? styles.actionButtonMine : {}) }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <form style={styles.composer} onSubmit={handleSubmit}>
        <div style={styles.composerInputWrap}>
          <textarea
            ref={composerInputRef}
            rows={1}
            style={styles.input}
            value={draft}
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            placeholder="Reply in thread"
            maxLength={10000}
            role="combobox"
            aria-expanded={Boolean(mention && mention.suggestions.length > 0)}
            aria-controls="thread-mention-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={
              mention && mention.highlightIndex >= 0
                ? `thread-mention-option-${mention.suggestions[mention.highlightIndex].id}`
                : undefined
            }
          />
          {mention && mention.suggestions.length > 0 && (
            <div
              ref={mentionDropdownRef}
              id="thread-mention-suggestions"
              role="listbox"
              aria-label="Mention suggestions"
              style={styles.suggestionDropdown}
            >
              {mention.suggestions.map((s, index) => (
                <div
                  key={s.id}
                  id={`thread-mention-option-${s.id}`}
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
        <button type="submit" style={styles.sendButton} disabled={!draft.trim()}>Reply</button>
      </form>
    </aside>
  );
}

export default memo(ThreadSidebar);
