import { useEffect, useState } from 'react';
import { X, UserPlus } from 'lucide-react';
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
  sectionHeading: {
    padding: '10px 16px 4px',
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  inviteRow: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  inviteText: { fontSize: 'var(--text-sm)', color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 6 },
  inviteActions: { display: 'flex', gap: 8 },
  acceptButton: {
    minHeight: 36,
    padding: '0 12px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
  },
  declineButton: {
    minHeight: 36,
    padding: '0 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
};

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export default function NotificationPanel({ onClose, onNavigate, onSummaryChange }) {
  const [notifications, setNotifications] = useState([]);
  const [summary, setSummary] = useState({ unreadCount: 0, mentionUnreadCount: 0, membershipInvitationUnreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [membershipInvitations, setMembershipInvitations] = useState([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationError, setInvitationError] = useState(null);
  const [respondingId, setRespondingId] = useState(null);

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

  async function loadMembershipInvitations() {
    setInvitationsLoading(true);
    setInvitationError(null);
    try {
      setMembershipInvitations(await notificationsApi.listMembershipInvitations());
    } catch (err) {
      setInvitationError(err.message || 'Failed to load invitations');
    } finally {
      setInvitationsLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadMembershipInvitations();
  }, []);

  async function markAllRead() {
    await notificationsApi.markAllMentionNotificationsRead();
    const nextSummary = {
      ...summary,
      mentionUnreadCount: 0,
      unreadCount: summary.membershipInvitationUnreadCount ?? 0,
    };
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setSummary(nextSummary);
    onSummaryChange?.(nextSummary);
  }

  async function respondToInvitation(invitation, accept) {
    setRespondingId(invitation.id);
    try {
      if (accept) {
        await notificationsApi.acceptMembershipInvitation(invitation.id);
      } else {
        await notificationsApi.declineMembershipInvitation(invitation.id);
      }
      setMembershipInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
      const data = await notificationsApi.getNotificationSummary();
      setSummary(data);
      onSummaryChange?.(data);
    } catch (err) {
      setInvitationError(err.message || 'Failed to respond to invitation');
    } finally {
      setRespondingId(null);
    }
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
        aria-label="Notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <h2 style={styles.title}>Notifications</h2>
          <button type="button" style={styles.button} onClick={markAllRead} disabled={(summary.mentionUnreadCount ?? summary.unreadCount) === 0}>
            Mark all read
          </button>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close notifications">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div style={styles.list}>
          <div style={styles.sectionHeading}>Invitations</div>
          {invitationsLoading && <div style={styles.status}>Loading invitations...</div>}
          {invitationError && <div style={styles.error}>{invitationError}</div>}
          {!invitationsLoading && !invitationError && membershipInvitations.length === 0 && (
            <div style={styles.status}>No pending invitations.</div>
          )}
          {!invitationsLoading &&
            !invitationError &&
            membershipInvitations.map((invitation) => (
              <div key={invitation.id} style={styles.inviteRow}>
                <span style={styles.inviteText}>
                  <UserPlus size={14} aria-hidden="true" />
                  <strong>{invitation.invitedByDisplayName || invitation.invitedByUsername}</strong>&nbsp;invited you to{' '}
                  <strong>{invitation.scopeName}</strong> as {invitation.invitedRole}
                </span>
                <span style={styles.inviteActions}>
                  <button
                    type="button"
                    style={styles.acceptButton}
                    disabled={respondingId === invitation.id}
                    onClick={() => respondToInvitation(invitation, true)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    style={styles.declineButton}
                    disabled={respondingId === invitation.id}
                    onClick={() => respondToInvitation(invitation, false)}
                  >
                    Decline
                  </button>
                </span>
              </div>
            ))}

          <div style={styles.sectionHeading}>Mentions</div>
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
                  <span style={styles.sender}>
                    {notification.senderDisplayName || notification.senderUsername} mentioned you
                  </span>
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
