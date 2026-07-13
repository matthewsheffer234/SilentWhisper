import { useState } from 'react';
import PresenceBadge from './PresenceBadge.jsx';
import Menu from './Menu.jsx';
import SearchBar from './SearchBar.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

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
  // FEATURE_REQUEST.md's Apple HIG UI/UX overhaul entry: this row used to
  // hold up to six controls (username, presence, notifications, Search,
  // Change Password, Sign out) and already needed flexWrap once to paper
  // over an overflow-clipping bug rather than fix the density that caused
  // it. Down to three now: username, presence, and a single user-menu
  // trigger — flexWrap kept as cheap insurance, not because it's expected
  // to be needed again.
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
  userMenuTrigger: {
    minWidth: 44,
    minHeight: 44,
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-md)',
  },
  adminToolsRow: {
    display: 'flex',
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
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
    gap: 4,
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
  // FEATURE_REQUEST.md's HIG overhaul entry: replaces the "Archive" pill
  // that used to sit permanently next to every eligible workspace's name —
  // Invite and Archive (previously scattered in two unrelated parts of the
  // sidebar for the same object) now live together behind this one trigger.
  // Sized like archivePill/joinPill, not a full 44px control — the row
  // itself is already a 44px-tall tap target, the same precedent those two
  // pills already established.
  overflowTrigger: {
    minWidth: 28,
    minHeight: 28,
    padding: '0 4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-md)',
    borderRadius: 6,
    flexShrink: 0,
  },
  archivedBadge: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginLeft: 4 },
  addButtonRow: { display: 'flex', gap: 6, marginTop: 6 },
  visibilityToggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
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
};

// A small, explicit, click-to-opt-in permission source — browsers
// increasingly suppress or penalize Notification.requestPermission() calls
// that aren't triggered by a direct user gesture, so this is never called
// automatically on mount. Once the browser has answered
// ('granted'/'denied'), the permission can't be re-prompted from script.
// Previously its own standalone button in userRow; now feeds a single item
// into the user Menu instead (FEATURE_REQUEST.md's HIG overhaul entry).
function useNotificationPermission() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState(supported ? window.Notification.permission : 'unsupported');

  async function requestPermission() {
    if (permission !== 'default') return;
    const result = await window.Notification.requestPermission();
    setPermission(result);
  }

  return { supported, permission, requestPermission };
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

// `showVisibilityToggle` (self-service workspace subscription,
// FEATURE_REQUEST.md) is opt-in so the channel-creation instance of this
// same form is unaffected — it calls `onSubmit(name)` with no second
// argument either way, same as before this feature existed.
function InlineCreateForm({ placeholder, onSubmit, extra, showVisibilityToggle }) {
  const [value, setValue] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  return (
    <form
      style={styles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim(), showVisibilityToggle ? (isPublic ? 'PUBLIC' : 'PRIVATE') : undefined);
        setValue('');
        setIsPublic(false);
      }}
    >
      <input
        style={styles.inlineInput}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {showVisibilityToggle && (
        <label style={styles.visibilityToggleLabel}>
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Public
        </label>
      )}
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
  onNavigateToSearchResult,
  onInviteMember,
  onOpenChangePassword,
  onOpenUserManagement,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onOpenBrowseWorkspaces,
}) {
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [inviteFormWorkspaceId, setInviteFormWorkspaceId] = useState(null);
  const notif = useNotificationPermission();
  const { theme, setTheme } = useTheme();

  // FEATURE_REQUEST.md: workspace archive/unarchive. Split rather than
  // filtered-with-a-toggle — the same pattern channels[].isMember already
  // uses to drive conditional rendering in this file (Join pill vs. not).
  const activeWorkspaces = workspaces.filter((ws) => !ws.archivedAt);
  const archivedWorkspaces = workspaces.filter((ws) => ws.archivedAt);
  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? null;
  const isSelectedWorkspaceArchived = Boolean(selectedWorkspace?.archivedAt);

  const userMenuItems = [
    ...(notif.supported
      ? [
          {
            key: 'notifications',
            label:
              notif.permission === 'granted'
                ? '🔔 Notifications on'
                : notif.permission === 'denied'
                  ? '🔕 Notifications blocked'
                  : '🔔 Enable notifications',
            disabled: notif.permission !== 'default',
            onSelect: notif.requestPermission,
          },
        ]
      : []),
    // Light/Dark appearance toggle (FEATURE_REQUEST.md). Three explicit
    // states rather than a two-way cycling toggle (Silent Lattice's own
    // control), matching how Apple's own Appearance setting is presented —
    // global.css's prefers-color-scheme layer already makes "System" a
    // real, meaningfully different option from picking Light/Dark outright.
    { key: 'theme-light', label: '☀ Light', checked: theme === 'light', separatorBefore: true, onSelect: () => setTheme('light') },
    { key: 'theme-dark', label: '☾ Dark', checked: theme === 'dark', onSelect: () => setTheme('dark') },
    { key: 'theme-system', label: '◐ System', checked: theme === 'system', onSelect: () => setTheme('system') },
    { key: 'change-password', label: 'Change Password', onSelect: onOpenChangePassword },
    { key: 'sign-out', label: 'Sign out', separatorBefore: true, onSelect: onLogout },
  ];

  return (
    <aside style={styles.sidebar}>
      <div style={styles.userRow}>
        <span style={styles.username}>{user?.username}</span>
        <PresenceBadge status={presence[user?.id] ?? 'online'} />
        <Menu
          ariaLabel="User menu"
          items={userMenuItems}
          renderTrigger={(triggerProps) => (
            <button type="button" {...triggerProps} style={styles.userMenuTrigger} aria-label="User menu">
              ⌄
            </button>
          )}
        />
      </div>

      <SearchBar onNavigate={onNavigateToSearchResult} />

      {canManageAi && (
        <div style={styles.adminToolsRow}>
          <Menu
            ariaLabel="Admin tools"
            items={[
              { key: 'ai-settings', label: 'AI Settings', onSelect: onOpenAiSettings },
              { key: 'audit-log', label: 'Audit Log', onSelect: onOpenAuditLog },
              { key: 'manage-users', label: 'Manage Users', onSelect: onOpenUserManagement },
            ]}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.aiSettingsButton}>
                ⚙ Admin Tools
              </button>
            )}
          />
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Workspaces</div>
        {activeWorkspaces.map((ws) => {
          const canInvite = ws.role === 'ADMIN';
          const canArchive = ws.ownerId === user?.id || ws.role === 'ADMIN';
          const workspaceMenuItems = [
            ...(canInvite ? [{ key: 'invite', label: 'Invite member…', onSelect: () => setInviteFormWorkspaceId(ws.id) }] : []),
            ...(canArchive
              ? [{ key: 'archive', label: 'Archive workspace', separatorBefore: canInvite, onSelect: () => onArchiveWorkspace(ws.id) }]
              : []),
          ];
          return (
            <div key={ws.id}>
              <div
                className="sl-row"
                role="button"
                tabIndex={0}
                style={{ ...styles.row, ...(ws.id === selectedWorkspaceId ? styles.rowActive : {}) }}
                onClick={() => onSelectWorkspace(ws.id)}
                onKeyDown={activateOnKey(() => onSelectWorkspace(ws.id))}
              >
                <span style={{ flex: 1 }}>{ws.name}</span>
                {workspaceMenuItems.length > 0 && (
                  <Menu
                    ariaLabel={`${ws.name} options`}
                    items={workspaceMenuItems}
                    renderTrigger={({ onClick, ...triggerProps }) => (
                      <button
                        type="button"
                        {...triggerProps}
                        style={styles.overflowTrigger}
                        aria-label={`${ws.name} options`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClick();
                        }}
                      >
                        ⋯
                      </button>
                    )}
                  />
                )}
              </div>
              {inviteFormWorkspaceId === ws.id && (
                <InviteMemberForm onSubmit={(username, role) => onInviteMember(ws.id, username, role)} />
              )}
            </div>
          );
        })}
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
            showVisibilityToggle
            onSubmit={(name, visibility) => {
              onCreateWorkspace(name, visibility);
              setShowNewWorkspace(false);
            }}
          />
        ) : (
          <div style={styles.addButtonRow}>
            <button
              type="button"
              style={{ ...styles.addButton, flex: 1, marginTop: 0 }}
              onClick={() => setShowNewWorkspace(true)}
            >
              + New workspace
            </button>
            <button
              type="button"
              style={{ ...styles.addButton, flex: 1, marginTop: 0 }}
              onClick={onOpenBrowseWorkspaces}
            >
              Browse workspaces
            </button>
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
