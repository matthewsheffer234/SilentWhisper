import { useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';

const styles = {
  sidebar: {
    width: 260,
    minWidth: 260,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface-alt)',
    borderRight: '1px solid var(--border)',
    fontFamily: 'var(--font-sans)',
  },
  // flexWrap so a fourth item (the notification toggle) added alongside
  // username/presence/sign-out never repeats the fixed-260px overflow bug
  // adminToolsRow's own comment below already documents finding once.
  userRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    fontWeight: 600,
  },
  username: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // A separate row from userRow, not more items crammed into it — a fixed
  // 260px sidebar has no room for a long username plus three text buttons
  // on one line without clipping (a real overflow bug an e2e test caught:
  // "AI Settings" was rendering visually cut off to a single "S"). Wraps
  // naturally if both admin links are present and space is tight.
  adminToolsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
    gap: 4,
  },
  section: { padding: '12px 10px', overflowY: 'auto', flex: 1 },
  sectionTitle: {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    padding: '4px 8px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 8px',
    borderRadius: 8,
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    minHeight: 44,
  },
  rowActive: { background: 'var(--item-active-bg)', color: 'var(--item-active-fg)' },
  addButton: {
    width: '100%',
    marginTop: 6,
    padding: '8px 8px',
    minHeight: 44,
    borderRadius: 8,
    border: '1px dashed var(--border-strong)',
    background: 'transparent',
    color: 'var(--text-3)',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  inlineForm: { display: 'flex', gap: 6, padding: '6px 8px' },
  inlineInput: {
    flex: 1,
    minHeight: 36,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  roleSelect: {
    minHeight: 36,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  inviteSubmit: {
    minHeight: 36,
    padding: '0 10px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  inviteFeedback: { padding: '4px 8px', fontSize: 'var(--text-xs)' },
  inviteError: { color: '#c0392b' },
  inviteSuccess: { color: 'var(--brg)' },
  joinPill: {
    fontSize: 'var(--text-xs)',
    color: 'var(--brg)',
    fontWeight: 600,
    border: 'none',
    background: 'none',
    cursor: 'pointer',
  },
  archivePill: {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    fontWeight: 600,
    border: 'none',
    background: 'none',
    cursor: 'pointer',
  },
  archivedBadge: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginLeft: 4 },
  // 44px minimum tap target height (PROJECT_PLAN.md Section 7) — visually
  // compact text links, but the invisible hit area is full-size.
  aiSettingsButton: {
    minHeight: 44,
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  logout: {
    minHeight: 44,
    marginLeft: 'auto',
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  notificationButton: {
    minHeight: 44,
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  notificationButtonDisabled: { cursor: 'default', opacity: 0.6 },
};

// A small, explicit, click-to-opt-in control — browsers increasingly
// suppress or penalize Notification.requestPermission() calls that aren't
// triggered by a direct user gesture, so this is never called automatically
// on mount. Once the browser has answered ('granted'/'denied'), the
// permission can't be re-prompted from script — the button just reflects
// that status rather than pretending to still be actionable.
function NotificationPermissionButton() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState(supported ? window.Notification.permission : 'unsupported');

  if (!supported) return null;

  async function handleClick() {
    if (permission !== 'default') return;
    const result = await window.Notification.requestPermission();
    setPermission(result);
  }

  const label =
    permission === 'granted'
      ? '🔔 Notifications on'
      : permission === 'denied'
        ? '🔕 Notifications blocked'
        : '🔔 Enable notifications';

  return (
    <button
      type="button"
      style={{ ...styles.notificationButton, ...(permission !== 'default' ? styles.notificationButtonDisabled : {}) }}
      onClick={handleClick}
      disabled={permission !== 'default'}
    >
      {label}
    </button>
  );
}

// PROJECT_PLAN.md Section 8, Phase 5 accessibility pass: workspace/channel
// rows are plain divs (not <button>s — a channel row needs to nest its own
// separately-clickable "Join" button, and nested interactive elements
// inside a real <button> are invalid HTML), so keyboard activation isn't
// free the way it is for an actual button — this restores it explicitly.
function activateOnKey(handler) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}

function InlineCreateForm({ placeholder, onSubmit, extra }) {
  const [value, setValue] = useState('');
  return (
    <form
      style={styles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim());
        setValue('');
      }}
    >
      <input
        style={styles.inlineInput}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {extra}
    </form>
  );
}

// PROJECT_PLAN.md Section 11's "Post-Phase-5 finding" — there was previously
// no way for an admin to add anyone to a workspace they created except
// direct database access. `onSubmit` is expected to reject with a real
// `Error` (apiFetch's convention — see api/client.js) carrying a useful
// `.message` (unknown username, already a member, etc.) so it can be shown
// inline rather than swallowed.
function InviteMemberForm({ onSubmit }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;
    setStatus(null);
    try {
      await onSubmit(trimmed, role);
      setStatus({ type: 'success', message: `Added ${trimmed} to the workspace` });
      setUsername('');
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <input
          style={styles.inlineInput}
          placeholder="Username to invite"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <select style={styles.roleSelect} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="MEMBER">Member</option>
          <option value="ADMIN">Admin</option>
        </select>
        <button type="submit" style={styles.inviteSubmit}>Add</button>
      </form>
      {status && (
        <div style={{ ...styles.inviteFeedback, ...(status.type === 'error' ? styles.inviteError : styles.inviteSuccess) }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

export default function WorkspaceSidebar({
  user,
  presence,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  channels,
  selectedChannelId,
  onSelectChannel,
  onCreateChannel,
  onJoinChannel,
  onLogout,
  canManageAi,
  onOpenAiSettings,
  onOpenAuditLog,
  onOpenSearch,
  isSelectedWorkspaceAdmin,
  onInviteMember,
  onOpenChangePassword,
  onOpenUserManagement,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
}) {
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  // FEATURE_REQUEST.md: workspace archive/unarchive. Split rather than
  // filtered-with-a-toggle — the same pattern channels[].isMember already
  // uses to drive conditional rendering in this file (Join pill vs. not).
  const activeWorkspaces = workspaces.filter((ws) => !ws.archivedAt);
  const archivedWorkspaces = workspaces.filter((ws) => ws.archivedAt);
  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? null;
  const isSelectedWorkspaceArchived = Boolean(selectedWorkspace?.archivedAt);

  return (
    <aside style={styles.sidebar}>
      <div style={styles.userRow}>
        <span style={styles.username}>{user?.username}</span>
        <PresenceBadge status={presence[user?.id] ?? 'online'} />
        <NotificationPermissionButton />
        <button type="button" style={styles.aiSettingsButton} onClick={onOpenSearch}>Search</button>
        <button type="button" style={styles.aiSettingsButton} onClick={onOpenChangePassword}>Change Password</button>
        <button type="button" style={styles.logout} onClick={onLogout}>Sign out</button>
      </div>
      {canManageAi && (
        <div style={styles.adminToolsRow}>
          <button type="button" style={styles.aiSettingsButton} onClick={onOpenAiSettings}>
            AI Settings
          </button>
          <button type="button" style={styles.aiSettingsButton} onClick={onOpenAuditLog}>
            Audit Log
          </button>
          <button type="button" style={styles.aiSettingsButton} onClick={onOpenUserManagement}>
            Manage Users
          </button>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Workspaces</div>
        {activeWorkspaces.map((ws) => (
          <div
            key={ws.id}
            className="sl-row"
            role="button"
            tabIndex={0}
            style={{ ...styles.row, ...(ws.id === selectedWorkspaceId ? styles.rowActive : {}) }}
            onClick={() => onSelectWorkspace(ws.id)}
            onKeyDown={activateOnKey(() => onSelectWorkspace(ws.id))}
          >
            <span style={{ flex: 1 }}>{ws.name}</span>
            {(ws.ownerId === user?.id || ws.role === 'ADMIN') && (
              <button
                type="button"
                style={styles.archivePill}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchiveWorkspace(ws.id);
                }}
              >
                Archive
              </button>
            )}
          </div>
        ))}
        {archivedWorkspaces.length > 0 && (
          <>
            <div style={{ ...styles.sectionTitle, marginTop: 18 }}>Archived</div>
            {archivedWorkspaces.map((ws) => (
              <div
                key={ws.id}
                className="sl-row"
                role="button"
                tabIndex={0}
                style={{ ...styles.row, ...(ws.id === selectedWorkspaceId ? styles.rowActive : {}) }}
                onClick={() => onSelectWorkspace(ws.id)}
                onKeyDown={activateOnKey(() => onSelectWorkspace(ws.id))}
              >
                <span style={{ flex: 1 }}>{ws.name}</span>
                {ws.role === 'ADMIN' && (
                  <button
                    type="button"
                    style={styles.archivePill}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnarchiveWorkspace(ws.id);
                    }}
                  >
                    Unarchive
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {showNewWorkspace ? (
          <InlineCreateForm
            placeholder="Workspace name"
            onSubmit={(name) => {
              onCreateWorkspace(name);
              setShowNewWorkspace(false);
            }}
          />
        ) : (
          <button type="button" style={styles.addButton} onClick={() => setShowNewWorkspace(true)}>
            + New workspace
          </button>
        )}

        {selectedWorkspaceId && isSelectedWorkspaceAdmin && !isSelectedWorkspaceArchived && (
          <div style={{ marginTop: 10 }}>
            {showInvite ? (
              <InviteMemberForm
                onSubmit={(username, role) => onInviteMember(selectedWorkspaceId, username, role)}
              />
            ) : (
              <button type="button" style={styles.addButton} onClick={() => setShowInvite(true)}>
                + Invite member
              </button>
            )}
          </div>
        )}

        {selectedWorkspaceId && (
          <>
            <div style={{ ...styles.sectionTitle, marginTop: 18 }}>
              Channels
              {isSelectedWorkspaceArchived && <span style={styles.archivedBadge}>(archived — read only)</span>}
            </div>
            {channels.map((ch) => (
              <div
                key={ch.id}
                className="sl-row"
                role="button"
                tabIndex={0}
                style={{ ...styles.row, ...(ch.id === selectedChannelId ? styles.rowActive : {}) }}
                onClick={() => onSelectChannel(ch.id)}
                onKeyDown={activateOnKey(() => onSelectChannel(ch.id))}
              >
                <span>{ch.type === 'PRIVATE' ? '🔒' : '#'} {ch.name}</span>
                {!ch.isMember && !isSelectedWorkspaceArchived && (
                  <button
                    type="button"
                    style={styles.joinPill}
                    onClick={(e) => {
                      e.stopPropagation();
                      onJoinChannel(ch.id);
                    }}
                  >
                    Join
                  </button>
                )}
              </div>
            ))}
            {!isSelectedWorkspaceArchived &&
              (showNewChannel ? (
                <InlineCreateForm
                  placeholder="Channel name"
                  onSubmit={(name) => {
                    onCreateChannel(name, 'PUBLIC');
                    setShowNewChannel(false);
                  }}
                />
              ) : (
                <button type="button" style={styles.addButton} onClick={() => setShowNewChannel(true)}>
                  + New channel
                </button>
              ))}
          </>
        )}
      </div>
    </aside>
  );
}
