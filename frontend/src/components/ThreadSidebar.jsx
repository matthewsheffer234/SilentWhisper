import { memo, useEffect, useState } from 'react';
import { X, Sparkles, ChevronDown } from 'lucide-react';
import { UserPresenceBadge } from '../context/PresenceContext.jsx';
import Menu from './Menu.jsx';
import { extractTasks } from '../api/ai.js';
import { renderMessageContent } from '../markdown.jsx';
import { isFirstInRun, initials } from './ChannelView.jsx';
import { AI_THREAD_SCOPE, formatAiActionError, formatAiQueueLabel } from '../aiPresentation.js';

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
  replies: { flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
  composer: { display: 'flex', gap: 6, padding: '12px 16px', borderTop: '1px solid var(--border)' },
  input: {
    flex: 1,
    minHeight: 40,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
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
  rootMessage,
  replies,
  currentUser,
  onSendReply,
  onClose,
  isDirectConversation,
  onOpenEntity,
  onToggleTask,
  taskOverrides,
}) {
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState(null); // { loading, text, error, scope }

  useEffect(() => {
    setTasks(null);
  }, [rootMessage?.id]);

  if (!rootMessage) return null;

  function handleSubmit(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    onSendReply(draft.trim());
    setDraft('');
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
                <div style={styles.bubbleContent}>
                  {renderMessageContent(rootMessage.content, {
                    variant: useMineStyle ? 'mine' : undefined,
                    onEntityClick: onOpenEntity,
                    onToggleTask,
                    messageId: rootMessage.id,
                    taskOverrides,
                  })}
                </div>
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
                <div style={styles.bubbleContent}>
                  {renderMessageContent(r.content, {
                    variant: useMineStyle ? 'mine' : undefined,
                    onEntityClick: onOpenEntity,
                    onToggleTask: r.pending ? undefined : onToggleTask,
                    messageId: r.id,
                    taskOverrides,
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <form style={styles.composer} onSubmit={handleSubmit}>
        <input
          style={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Reply in thread"
          maxLength={10000}
        />
        <button type="submit" style={styles.sendButton} disabled={!draft.trim()}>Reply</button>
      </form>
    </aside>
  );
}

export default memo(ThreadSidebar);
