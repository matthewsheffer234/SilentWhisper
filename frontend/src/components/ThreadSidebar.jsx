import { useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';

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

  if (!rootMessage) return null;

  function handleSubmit(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    onSendReply(draft.trim());
    setDraft('');
  }

  return (
    <aside style={styles.sidebar}>
      <div style={styles.header}>
        Thread
        <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close thread">×</button>
      </div>
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
