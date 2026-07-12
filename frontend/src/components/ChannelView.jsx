import { useEffect, useRef, useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';

const styles = {
  wrapper: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface)' },
  header: {
    padding: '14px 20px',
    borderBottom: '1px solid var(--border)',
    fontSize: 'var(--text-md)',
    fontWeight: 700,
    color: 'var(--text-1)',
  },
  feed: { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 },
  messageRow: { display: 'flex', flexDirection: 'column', maxWidth: '70ch' },
  messageMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  messageAuthor: { fontWeight: 700, color: 'var(--text-1)' },
  messageContent: { fontSize: 'var(--text-base)', color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
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
  composer: { display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)' },
  input: {
    flex: 1,
    minHeight: 44,
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    boxShadow: 'var(--input-shadow)',
    fontSize: 'var(--text-base)',
  },
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

export default function ChannelView({ channel, messages, presence, currentUser, joined, onSend, onOpenThread }) {
  const [draft, setDraft] = useState('');
  const feedRef = useRef(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [messages]);

  if (!channel) {
    return (
      <div style={styles.wrapper}>
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

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>{channel.type === 'PRIVATE' ? '🔒' : '#'} {channel.name}</div>
      <div style={styles.feed} ref={feedRef}>
        {messages.length === 0 && <div style={styles.empty}>No messages yet — say hello.</div>}
        {messages.map((m) => (
          <div key={m.id} className="sl-row" style={{ ...styles.messageRow, ...(m.pending ? styles.pending : {}) }}>
            <div style={styles.messageMeta}>
              <span style={styles.messageAuthor}>{m.username}</span>
              <PresenceBadge status={presence[m.userId] ?? 'offline'} />
              <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style={styles.messageContent}>{m.content}</div>
            {!m.parentMessageId && !m.pending && (
              <button type="button" style={styles.replyButton} onClick={() => onOpenThread(m)}>
                Reply in thread
              </button>
            )}
          </div>
        ))}
      </div>
      <form style={styles.composer} onSubmit={handleSubmit}>
        <input
          style={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={joined ? `Message #${channel.name}` : 'Joining channel…'}
          disabled={!joined}
          maxLength={10000}
        />
        <button type="submit" style={styles.sendButton} disabled={!joined || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
