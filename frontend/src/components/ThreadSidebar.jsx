import { useEffect, useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';
import { extractTasks } from '../api/ai.js';
import { renderMessageContent } from '../markdown.jsx';

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
  extractButton: {
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--brg)',
    background: 'none',
    border: '1px solid var(--brg)',
    borderRadius: 999,
    padding: '0 12px',
    cursor: 'pointer',
  },
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
  rowOuter: { display: 'flex', width: '100%' },
  bubble: { display: 'flex', flexDirection: 'column', maxWidth: '80%', borderRadius: 14, padding: '7px 10px', boxSizing: 'border-box' },
  bubbleMine: { background: 'var(--brg)', color: 'var(--item-active-fg)' },
  bubbleTheirs: { background: 'var(--surface)', color: 'var(--text-1)' },
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

export default function ThreadSidebar({ rootMessage, replies, presence, currentUser, onSendReply, onClose }) {
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState(null); // { loading, text, error }

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
    setTasks({ loading: true, text: '', error: null });
    try {
      await extractTasks(rootMessage.id, (chunk) => {
        setTasks((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
      });
      setTasks((prev) => (prev ? { ...prev, loading: false } : prev));
    } catch (err) {
      setTasks({ loading: false, text: '', error: err.message || 'Failed to extract tasks' });
    }
  }

  return (
    <aside style={styles.sidebar}>
      <div style={styles.header}>
        Thread
        <div style={styles.headerActions}>
          <button type="button" style={styles.extractButton} onClick={handleExtractTasks} disabled={tasks?.loading}>
            {tasks?.loading ? 'Extracting…' : 'Extract Tasks'}
          </button>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close thread">×</button>
        </div>
      </div>
      {tasks && (
        <div style={styles.taskPanel}>
          <div style={styles.taskPanelHeader}>
            <span>Action items</span>
            <button type="button" style={styles.closeButton} onClick={() => setTasks(null)} aria-label="Close action items">×</button>
          </div>
          {tasks.error ? (
            <div style={styles.taskError}>{tasks.error}</div>
          ) : (
            <div>{tasks.text || (tasks.loading ? 'Reading thread…' : '')}</div>
          )}
        </div>
      )}
      <div style={styles.root}>
        {(() => {
          const isMine = rootMessage.userId === currentUser.id;
          return (
            <div style={{ ...styles.rowOuter, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
              <div className="sl-row" style={{ ...styles.bubble, ...(isMine ? styles.bubbleMine : styles.bubbleTheirs) }}>
                <div style={{ ...styles.bubbleMeta, ...(isMine ? styles.bubbleMetaMine : {}) }}>
                  {!isMine && <span style={styles.bubbleAuthor}>{rootMessage.username}</span>}
                  <PresenceBadge status={presence[rootMessage.userId] ?? 'offline'} variant={isMine ? 'onMine' : undefined} />
                </div>
                <div style={styles.bubbleContent}>
                  {renderMessageContent(rootMessage.content, { variant: isMine ? 'mine' : undefined })}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
      <div style={styles.replies}>
        {replies.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>No replies yet.</div>}
        {replies.map((r) => {
          const isMine = r.userId === currentUser.id;
          return (
            <div key={r.id} style={{ ...styles.rowOuter, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
              <div className="sl-row" style={{ ...styles.bubble, ...(isMine ? styles.bubbleMine : styles.bubbleTheirs) }}>
                <div style={{ ...styles.bubbleMeta, ...(isMine ? styles.bubbleMetaMine : {}) }}>
                  {!isMine && <span style={styles.bubbleAuthor}>{r.username}</span>}
                  <PresenceBadge status={presence[r.userId] ?? 'offline'} variant={isMine ? 'onMine' : undefined} />
                </div>
                <div style={styles.bubbleContent}>{renderMessageContent(r.content, { variant: isMine ? 'mine' : undefined })}</div>
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
