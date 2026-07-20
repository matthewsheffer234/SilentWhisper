import { useState } from 'react';
import {
  ChevronDown,
  Settings,
  MoreHorizontal,
  Hash,
  Lock,
  Bell,
  BellOff,
  Sun,
  Moon,
  SunMoon,
  Plus,
  User,
  Users,
  Sparkles,
} from 'lucide-react';
import PresenceBadge from './PresenceBadge.jsx';
import Menu from './Menu.jsx';
import SearchBar from './SearchBar.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { PERMISSIONS, hasPermission, hasOrgManagementAccess } from '../authz/permissions.js';
import { directMessageLabel } from '../directMessages.js';
import { canSelfJoinChannel } from '../channels.js';

// Menu.jsx renders `item.label` as arbitrary children, not just text — this
// composes an icon + text pair with the same layout Menu.jsx's own item row
// already uses (flex, gap 8), so icon-bearing labels line up identically to
// plain-text ones.
function IconLabel({ icon, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {icon}
      {children}
    </span>
  );
}

// FEATURE_REQUEST.md entry 2 (2026-07-20 backlog): relocated here from a
// standalone row in WorkspaceHome.jsx, which only rendered while no channel
// was open — the one feature meant to summarize activity *across* channels
// disappeared the moment you opened any of them. Icon-only, reusing
// overflowTrigger's plain-icon styling rather than ChannelView.jsx/
// ThreadSidebar.jsx's wider pill-with-label "AI Actions" trigger — the
// sidebar row is already tight on width (workspace name + settings icon
// competing for room), and `aria-label` carries the meaning a visible label
// would otherwise. A single button, not a Menu.jsx popover, since there's
// exactly one workspace-level AI action today; converting to a menu is the
// natural next step if a second one is ever added, not something to build
// out now for one item.
//
// Kept as a standalone, exported pure function — same pattern
// ChannelView.jsx's isFirstInRun/formatReplyCount/initials already
// establish — so it's unit-testable directly (this frontend's Vitest setup
// has no jsdom, per ChannelView.test.jsx's own documented reasoning).
// Deliberately has no archived-state parameter: unlike the settings
// overflow trigger, generating a digest is read-only and doesn't require
// write access, so both the active- and archived-workspace row blocks call
// this identically, with no separate "unless archived" branch to hide it.
export function shouldShowDigestTrigger(workspaceId, selectedWorkspaceId, channelCount) {
  return workspaceId === selectedWorkspaceId && channelCount > 0;
}

function DigestTrigger({ onOpenDigest }) {
  return (
    <button
      type="button"
      style={styles.overflowTrigger}
      aria-label="Catch Me Up — workspace digest"
      onClick={(e) => {
        e.stopPropagation();
        onOpenDigest();
      }}
    >
      <Sparkles size={18} aria-hidden="true" />
    </button>
  );
}

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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 8,
    border: '1px dashed var(--border-strong)',
    background: 'transparent',
    color: 'var(--text-3)',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
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
  userMenuWrap: { position: 'relative', marginLeft: 'auto' },
  notificationBadge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    padding: '0 4px',
    borderRadius: 999,
    background: '#c0392b',
    color: '#fff',
    fontSize: '10px',
    fontWeight: 700,
    lineHeight: '16px',
    textAlign: 'center',
    pointerEvents: 'none',
  },
  archivedBadge: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginLeft: 4 },
  dmRowLabel: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  addButtonRow: { display: 'flex', gap: 6, marginTop: 6 },
  // 44px minimum tap target height (PROJECT_PLAN.md Section 7) — visually
  // compact text links, but the invisible hit area is full-size.
  aiSettingsButton: {
    minHeight: 44,
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
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

export default function WorkspaceSidebar({
  user,
  presence,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  channels,
  selectedChannelId,
  onSelectChannel,
  onJoinChannel,
  onLogout,
  canManageWorkspaceUsers,
  onNavigateToSearchResult,
  onOpenChangePassword,
  onOpenDisplayName,
  onUnarchiveWorkspace,
  onOpenBrowseWorkspaces,
  organizations,
  selectedOrganizationId,
  onSelectOrganization,
  isSystemAdmin,
  onOpenCreateOrganization,
  onOpenAdminPanel,
  onOpenWorkspaceSettings,
  onOpenDigest,
  notificationSummary,
  onOpenNotifications,
  onOpenCreateWorkspace,
  onOpenCreateChannel,
  directMessages,
  onOpenNewMessage,
}) {
  const notif = useNotificationPermission();
  const { theme, setTheme } = useTheme();

  // Org-scoped (FEATURE_REQUEST.md entry 1, slice 3): filters/groups
  // client-side rather than refetching from the server on every switch, for
  // instant switching with no network round-trip or loading flicker — a
  // structural no-op for every account with exactly one org (the
  // overwhelming majority today), same "no-op until a second org exists"
  // continuity property slice 2 established server-side.
  const orgFilteredWorkspaces = selectedOrganizationId
    ? workspaces.filter((ws) => ws.organizationId === selectedOrganizationId)
    : workspaces; // no orgs loaded yet — show everything rather than flash empty

  // FEATURE_REQUEST.md: workspace archive/unarchive. Split rather than
  // filtered-with-a-toggle — the same pattern channels[].isMember already
  // uses to drive conditional rendering in this file (Join pill vs. not).
  const activeWorkspaces = orgFilteredWorkspaces.filter((ws) => !ws.archivedAt);
  const archivedWorkspaces = orgFilteredWorkspaces.filter((ws) => ws.archivedAt);
  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? null;
  const isSelectedWorkspaceArchived = Boolean(selectedWorkspace?.archivedAt);

  const currentOrg = organizations.find((o) => o.id === selectedOrganizationId) ?? null;
  // "Manage organization members…" moved to the Admin hub (FEATURE_REQUEST.md's
  // "dedicated admin/settings area" entry) — the switcher's job narrows to
  // switching and, for a system admin, creating a new org.
  const orgSwitcherItems = [
    ...organizations.map((org) => ({
      key: org.id,
      label: org.name,
      checked: org.id === selectedOrganizationId,
      onSelect: () => onSelectOrganization(org.id),
    })),
    ...(isSystemAdmin
      ? [
          {
            key: 'create-org',
            label: <IconLabel icon={<Plus size={14} aria-hidden="true" />}>Create organization…</IconLabel>,
            separatorBefore: true,
            onSelect: onOpenCreateOrganization,
          },
        ]
      : []),
  ];

  // Organization controls are only useful when there is a decision or an
  // admin action to make — a bare single-org switcher with one always-
  // checked, non-actionable entry is exactly the "database administration
  // surface" friction FEATURE_REQUEST.md entry 2 asks to de-emphasize. Org
  // *management* access alone no longer forces the switcher to show (that
  // entry point moved to the Admin hub) — only an actual switch/create
  // decision does.
  const showOrgRow = organizations.length > 1 || isSystemAdmin;

  // FEATURE_REQUEST.md's "dedicated admin/settings area" entry: the Admin
  // hub is worth showing if the caller has *any* of the privileged
  // capabilities it groups — workspace-scoped user admin
  // (canManageWorkspaceUsers), managing at least one organization, or
  // system admin (which alone also unlocks the hub's AI Settings/Audit Log
  // rows — see AdminPanel.jsx).
  const canManageAnyOrg = organizations.some((org) => hasOrgManagementAccess(isSystemAdmin, org.role));
  const showAdminButton = canManageWorkspaceUsers || canManageAnyOrg || isSystemAdmin;

  const userMenuItems = [
    {
      key: 'mention-notifications',
      label: `Notifications${notificationSummary?.unreadCount ? ` (${notificationSummary.unreadCount})` : ''}`,
      onSelect: onOpenNotifications,
    },
    ...(notif.supported
      ? [
          {
            key: 'notifications',
            label:
              notif.permission === 'granted' ? (
                <IconLabel icon={<Bell size={14} aria-hidden="true" />}>Notifications on</IconLabel>
              ) : notif.permission === 'denied' ? (
                <IconLabel icon={<BellOff size={14} aria-hidden="true" />}>Notifications blocked</IconLabel>
              ) : (
                <IconLabel icon={<Bell size={14} aria-hidden="true" />}>Enable notifications</IconLabel>
              ),
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
    {
      key: 'theme-light',
      label: <IconLabel icon={<Sun size={14} aria-hidden="true" />}>Light</IconLabel>,
      checked: theme === 'light',
      separatorBefore: true,
      onSelect: () => setTheme('light'),
    },
    {
      key: 'theme-dark',
      label: <IconLabel icon={<Moon size={14} aria-hidden="true" />}>Dark</IconLabel>,
      checked: theme === 'dark',
      onSelect: () => setTheme('dark'),
    },
    {
      key: 'theme-system',
      label: <IconLabel icon={<SunMoon size={14} aria-hidden="true" />}>System</IconLabel>,
      checked: theme === 'system',
      onSelect: () => setTheme('system'),
    },
    // FEATURE_REQUEST.md entry 4 (navigation-first sidebar redesign):
    // previously its own always-visible `adminToolsRow` sitting in the same
    // vertical rhythm as search/workspaces/channels — moved into the user
    // menu (opened on demand, not rendered permanently) so ordinary,
    // non-admin messaging doesn't carry a constant reminder that privileged
    // controls exist. Still opens the same AdminPanel.jsx hub.
    ...(showAdminButton
      ? [
          {
            key: 'admin',
            label: <IconLabel icon={<Settings size={14} aria-hidden="true" />}>Admin</IconLabel>,
            separatorBefore: true,
            onSelect: onOpenAdminPanel,
          },
        ]
      : []),
    { key: 'display-name', label: 'Display Name', onSelect: onOpenDisplayName },
    { key: 'change-password', label: 'Change Password', onSelect: onOpenChangePassword },
    { key: 'sign-out', label: 'Sign out', separatorBefore: true, onSelect: onLogout },
  ];

  return (
    <aside style={styles.sidebar}>
      <div style={styles.userRow}>
        <span style={styles.username}>{user?.displayName || user?.username}</span>
        <PresenceBadge status={presence[user?.id] ?? 'online'} />
        <div style={styles.userMenuWrap}>
          <Menu
            ariaLabel="User menu"
            items={userMenuItems}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.userMenuTrigger} aria-label="User menu">
                <ChevronDown size={18} aria-hidden="true" />
              </button>
            )}
          />
          {notificationSummary?.unreadCount > 0 && (
            <span style={styles.notificationBadge}>
              {notificationSummary.unreadCount > 9 ? '9+' : notificationSummary.unreadCount}
            </span>
          )}
        </div>
      </div>

      <SearchBar onNavigate={onNavigateToSearchResult} />

      {showOrgRow && (
        <div style={styles.adminToolsRow}>
          <Menu
            ariaLabel="Organization switcher"
            items={orgSwitcherItems}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.aiSettingsButton}>
                {currentOrg?.name ?? 'Organization'}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
          />
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Workspaces</div>
        {activeWorkspaces.map((ws) => {
          const canInvite = hasPermission(ws.role, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
          const canArchive = hasPermission(ws.role, PERMISSIONS.WORKSPACE_ARCHIVE);
          // Owner-only block (FEATURE_REQUEST.md entry 1, slice 4): all
          // three permissions here are OWNER-only, so checking one is
          // effectively one gate for the whole block — kept as three
          // separate checks anyway so a future narrowing of any one of them
          // doesn't silently widen the others.
          const canTransferOwnership = hasPermission(ws.role, PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP);
          const canChangeVisibility = hasPermission(ws.role, PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY);
          const canManageSettings = hasPermission(ws.role, PERMISSIONS.WORKSPACE_MANAGE_SETTINGS);
          // FEATURE_REQUEST.md's "dedicated admin/settings area" entry:
          // what used to be up to five separate overflow-menu items
          // (Invite member…, Create invite link…, Archive workspace,
          // Transfer ownership…, the visibility-toggle label, and the
          // managers-can-archive checkbox) collapses to one trigger opening
          // WorkspaceSettingsSheet, which gates each of its own sections on
          // these same permissions internally.
          const hasWorkspaceSettings = canInvite || canArchive || canTransferOwnership || canChangeVisibility || canManageSettings;
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
                {/* Read-only, so shown regardless of the row's own archived
                    state below — unlike the settings trigger, generating a
                    digest doesn't require write access to the workspace. */}
                {shouldShowDigestTrigger(ws.id, selectedWorkspaceId, channels.length) && (
                  <DigestTrigger onOpenDigest={onOpenDigest} />
                )}
                {hasWorkspaceSettings && (
                  <button
                    type="button"
                    style={styles.overflowTrigger}
                    aria-label={`${ws.name} settings`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenWorkspaceSettings(ws.id);
                    }}
                  >
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
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
                {/* Read-only, so shown even for an archived workspace —
                    same reasoning as the active-workspace row above. */}
                {shouldShowDigestTrigger(ws.id, selectedWorkspaceId, channels.length) && (
                  <DigestTrigger onOpenDigest={onOpenDigest} />
                )}
                {hasPermission(ws.role, PERMISSIONS.WORKSPACE_ARCHIVE) && (
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
        <div style={styles.addButtonRow}>
          <button
            type="button"
            style={{ ...styles.addButton, flex: 1, marginTop: 0 }}
            onClick={onOpenCreateWorkspace}
          >
            <Plus size={14} aria-hidden="true" />
            New workspace
          </button>
          <button
            type="button"
            style={{ ...styles.addButton, flex: 1, marginTop: 0 }}
            onClick={onOpenBrowseWorkspaces}
          >
            Join a workspace
          </button>
        </div>

        {selectedWorkspaceId && (
          <>
            <div style={{ ...styles.sectionTitle, marginTop: 18 }}>
              Channels
              {isSelectedWorkspaceArchived && <span style={styles.archivedBadge}>(archived — read only)</span>}
            </div>
            {channels.map((ch) => {
              return (
                <div key={ch.id}>
                  <div
                    className="sl-row"
                    role="button"
                    tabIndex={0}
                    style={{ ...styles.row, ...(ch.id === selectedChannelId ? styles.rowActive : {}) }}
                    onClick={() => onSelectChannel(ch.id)}
                    onKeyDown={activateOnKey(() => onSelectChannel(ch.id))}
                  >
                    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {ch.type === 'PRIVATE' ? <Lock size={14} aria-hidden="true" /> : <Hash size={14} aria-hidden="true" />}
                      {ch.name}
                    </span>
                    {canSelfJoinChannel(ch) && !isSelectedWorkspaceArchived && (
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
                </div>
              );
            })}
            {!isSelectedWorkspaceArchived && (
              <button type="button" style={styles.addButton} onClick={onOpenCreateChannel}>
                <Plus size={14} aria-hidden="true" />
                New channel
              </button>
            )}
          </>
        )}

        {/* FEATURE_REQUEST.md entry 3 (Direct Messages navigation): not
            gated on selectedWorkspaceId — DMs are workspace-independent
            (channels.workspace_id is NULL for DIRECT/GROUP_DM, PROJECT_PLAN.md
            Section 4), so this section is always visible, matching
            UI_UX_REVIEW.md's suggested "Direct Messages" nav section. */}
        <div style={{ ...styles.sectionTitle, marginTop: 18 }}>Direct Messages</div>
        {directMessages.map((dm) => (
          <div
            key={dm.id}
            className="sl-row"
            role="button"
            tabIndex={0}
            style={{ ...styles.row, ...(dm.id === selectedChannelId ? styles.rowActive : {}) }}
            onClick={() => onSelectChannel(dm.id)}
            onKeyDown={activateOnKey(() => onSelectChannel(dm.id))}
          >
            <span style={styles.dmRowLabel}>
              {dm.type === 'GROUP_DM' ? <Users size={14} aria-hidden="true" /> : <User size={14} aria-hidden="true" />}
              {directMessageLabel(dm)}
            </span>
          </div>
        ))}
        <button type="button" style={styles.addButton} onClick={onOpenNewMessage}>
          <Plus size={14} aria-hidden="true" />
          New message
        </button>
      </div>
    </aside>
  );
}
