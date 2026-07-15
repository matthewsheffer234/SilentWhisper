import { useEffect, useState } from 'react';
import * as notificationsApi from '../api/notifications.js';

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.18)',
    zIndex: 50,
    display: 'flex',
    justifyContent: 'flex-start',
  },
  panel: {
    width: 360,
    maxWidth: 'calc(100vw - 24px)',
    height: '100vh',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    borderRight: '1px solid var(--border)',
    boxShadow: 'var(--overlay-shadow)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'var(--font-sans)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  title: { flex: 1, margin: 0, fontSize: 'var(--text-lg)' },
  button: {
    minHeight: 36,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    border: 'none',
    background: 'none',
    color: 'var(--text-3)',
    fontSize: 'var(--text-lg)',
    cursor: 'pointer',
  },
  list: { overflowY: 'auto', flex: 1 },
  status: { padding: 18, color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
  error: { padding: 18, color: '#c0392b', fontSize: 'var(--text-sm)' },
  row: (unread) => ({
    width: '100%',
    display: 'block',
    textAlign: 'left',
    padding: '12px 16px',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    background: unread ? 'var(--brg-dim)' : 'transparent',
    color: 'var(--text-1)',
    cursor: 'pointer',
  }),
  rowHead: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' },
  sender: { fontWeight: 700, fontSize: 'var(--text-sm)' },
  time: { color: 'var(--text-3)', fontSize: 'var(--text-xs)', flexShrink: 0 },
  location: { color: 'var(--text-3)', fontSize: 'var(--text-xs)', marginTop: 2 },
  preview: { color: 'var(--text-2)', fontSize: 'var(--text-sm)', marginTop: 6, lineHeight: 1.35 },
};

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export default function NotificationPanel({ onClose, onNavigate, onSummaryChange }) {
  const [notifications, setNotifications] = useState([]);
  const [summary, setSummary] = useState({ unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await notificationsApi.listMentionNotifications({ limit: 30 });
      setNotifications(data.notifications);
      setSummary(data.summary);
      onSummaryChange?.(data.summary);
    } catch (err) {
      setError(err.message || 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markAllRead() {
    await notificationsApi.markAllMentionNotificationsRead();
    const nextSummary = { ...summary, unreadCount: 0, byWorkspace: [], byChannel: [] };
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setSummary(nextSummary);
    onSummaryChange?.(nextSummary);
  }

  async function openNotification(notification) {
    if (!notification.readAt) {
      await notificationsApi.markMentionNotificationRead(notification.id);
    }
    onNavigate(notification);
    onClose();
  }

  return (
    <div style={styles.backdrop} onMouseDown={onClose}>
      <section
        style={styles.panel}
        aria-label="Mention notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <h2 style={styles.title}>Mentions</h2>
          <button type="button" style={styles.button} onClick={markAllRead} disabled={summary.unreadCount === 0}>
            Mark all read
          </button>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close notifications">
            x
          </button>
        </div>
        <div style={styles.list}>
          {loading && <div style={styles.status}>Loading mentions...</div>}
          {error && <div style={styles.error}>{error}</div>}
          {!loading && !error && notifications.length === 0 && <div style={styles.status}>No mentions yet.</div>}
          {!loading &&
            !error &&
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                style={styles.row(!notification.readAt)}
                onClick={() => openNotification(notification)}
              >
                <span style={styles.rowHead}>
                  <span style={styles.sender}>{notification.senderUsername} mentioned you</span>
                  <span style={styles.time}>{formatTime(notification.createdAt)}</span>
                </span>
                <span style={styles.location}>
                  {notification.workspaceName ? `${notification.workspaceName} / ` : ''}
                  {notification.channelName}
                </span>
                <span style={styles.preview}>{notification.preview}</span>
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
