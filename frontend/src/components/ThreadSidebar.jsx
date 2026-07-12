import { useEffect, useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';
import { extractTasks } from '../api/ai.js';

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
  extractButton: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--brg)',
    background: 'none',
    border: '1px solid var(--brg)',
    borderRadius: 999,
    padding: '3px 10px',
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
  closeButton: { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 'var(--text-md)' },
  root: { padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  rootAuthor: { fontWeight: 700, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  rootContent: { fontSize: 'var(--text-sm)', color: 'var(--text-2)', marginTop: 4, whiteSpace: 'pre-wrap' },
  replies: { flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
  reply: { fontSize: 'var(--text-sm)' },
  replyMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  replyAuthor: { fontWeight: 700, color: 'var(--text-1)' },
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

export default function ThreadSidebar({ rootMessage, replies, presence, onSendReply, onClose }) {
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
        <div style={styles.rootAuthor}>{rootMessage.username}</div>
        <div style={styles.rootContent}>{rootMessage.content}</div>
      </div>
      <div style={styles.replies}>
        {replies.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>No replies yet.</div>}
        {replies.map((r) => (
          <div key={r.id} style={styles.reply}>
            <div style={styles.replyMeta}>
              <span style={styles.replyAuthor}>{r.username}</span>
              <PresenceBadge status={presence[r.userId] ?? 'offline'} />
            </div>
            <div>{r.content}</div>
          </div>
        ))}
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
