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
} from 'lucide-react';
import PresenceBadge from './PresenceBadge.jsx';
import Menu from './Menu.jsx';
import SearchBar from './SearchBar.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { PERMISSIONS, hasPermission, hasOrgManagementAccess } from '../authz/permissions.js';
import { searchWorkspacePeople, searchWorkspaceMembers } from '../api/workspaces.js';

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
  inlineForm: { display: 'flex', gap: 6, padding: '6px 8px' },
  inlineInput: {
    flex: 1,
    minWidth: 0,
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

// `visibilityToggle` (self-service workspace subscription, FEATURE_REQUEST.md;
// generalized for the private-channel toggle) is opt-in so a plain call site
// with no toggle at all is unaffected — it calls `onSubmit(name)` with no
// second argument either way, same as before either feature existed.
// Shape: { label, onValue, offValue, defaultOn }. One shared checkbox control
// for both call sites rather than two near-identical toggles, per this app's
// existing consistency convention (PROJECT_PLAN.md Section 7 / FEATURE_REQUEST.md's
// Apple HIG overhaul entry) — the same visible control should mean the same
// thing everywhere it appears.
function InlineCreateForm({ placeholder, onSubmit, extra, visibilityToggle }) {
  const [value, setValue] = useState('');
  const [toggleOn, setToggleOn] = useState(visibilityToggle?.defaultOn ?? false);
  return (
    <form
      style={styles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim(), visibilityToggle ? (toggleOn ? visibilityToggle.onValue : visibilityToggle.offValue) : undefined);
        setValue('');
        setToggleOn(visibilityToggle?.defaultOn ?? false);
      }}
    >
      <input
        style={styles.inlineInput}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {visibilityToggle && (
        <label style={styles.visibilityToggleLabel} title={visibilityToggle.hint}>
          <input type="checkbox" checked={toggleOn} onChange={(e) => setToggleOn(e.target.checked)} />
          {visibilityToggle.label}
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
// FEATURE_REQUEST.md's "unified people picker" entry replaced the raw
// exact-username `<input>` these three forms used to have with
// `PeoplePicker` — search by display name/username/email, with ineligible
// rows (already a member, already in this channel, yourself) shown
// disabled rather than only failing after submit.
function InviteMemberForm({ onSubmit, workspaceId }) {
  const [person, setPerson] = useState(null);
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setStatus(null);
    try {
      await onSubmit(person.username, role);
      setStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the workspace` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PeoplePicker
            searchFn={(q) => searchWorkspacePeople(workspaceId, q)}
            value={person}
            onChange={setPerson}
            placeholder="Search people to invite"
            ariaLabel="Search people to invite"
            isIneligible={(p) => (p.alreadyMember ? 'Already a member' : null)}
          />
        </div>
        <select style={styles.roleSelect} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="MEMBER">Member</option>
          <option value="MANAGER">Manager</option>
        </select>
        <button type="submit" style={styles.inviteSubmit} disabled={!person}>Add</button>
      </form>
      {status && (
        <div style={{ ...styles.inviteFeedback, ...(status.type === 'error' ? styles.inviteError : styles.inviteSuccess) }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

// Private-channel invite workflow — cloned from InviteMemberForm's shape,
// minus the role select (channel membership carries no role, unlike
// workspace membership). Only ever rendered for a PRIVATE channel the caller
// already belongs to (see the channel row below) — a public channel's
// self-service "Join" pill already covers the public case, so this control
// only needs to exist for the one case self-join can't handle. Candidate
// pool is current workspace members only (searchWorkspaceMembers), not
// every account — matches the add-to-channel endpoint's own requirement
// that the target already belong to the workspace.
function InviteToChannelForm({ onSubmit, workspaceId, channelId }) {
  const [person, setPerson] = useState(null);
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setStatus(null);
    try {
      await onSubmit(person.username);
      setStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the channel` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PeoplePicker
            searchFn={(q) => searchWorkspaceMembers(workspaceId, q, { channelId })}
            value={person}
            onChange={setPerson}
            placeholder="Search workspace members to add"
            ariaLabel="Search workspace members to add to channel"
            isIneligible={(p) => (p.alreadyInChannel ? 'Already in this channel' : null)}
          />
        </div>
        <button type="submit" style={styles.inviteSubmit} disabled={!person}>Add</button>
      </form>
      {status && (
        <div style={{ ...styles.inviteFeedback, ...(status.type === 'error' ? styles.inviteError : styles.inviteSuccess) }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

// New (FEATURE_REQUEST.md entry 1, slice 4). Candidate pool is current
// workspace members only, matching POST /:workspaceId/transfer-ownership's
// own requirement that the target already be a member.
function TransferOwnershipForm({ onSubmit, workspaceId }) {
  const [person, setPerson] = useState(null);
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setStatus(null);
    try {
      await onSubmit(person.username);
      setStatus({ type: 'success', message: `Ownership transferred to ${person.displayName || person.username}` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to transfer ownership' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PeoplePicker
            searchFn={(q) => searchWorkspaceMembers(workspaceId, q)}
            value={person}
            onChange={setPerson}
            placeholder="Search workspace members"
            ariaLabel="Search workspace members for ownership transfer"
            isIneligible={(p) => (p.isSelf ? 'Cannot transfer to yourself' : null)}
          />
        </div>
        <button type="submit" style={styles.inviteSubmit} disabled={!person}>Transfer</button>
      </form>
      {status && (
        <div style={{ ...styles.inviteFeedback, ...(status.type === 'error' ? styles.inviteError : styles.inviteSuccess) }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

// Token-based invitation (FEATURE_REQUEST.md entry 1, slice 3) — for people
// who don't have an account yet, coexists with InviteMemberForm above
// (direct-add of an existing user), doesn't replace it. No email infra
// exists in this project (backend/src/routes/workspaces.js's own comment),
// so the raw link is shown once for the admin to copy/share out-of-band.
function InviteLinkForm({ onSubmit }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null); // { type: 'error' | 'success', message }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus(null);
    try {
      const invitation = await onSubmit(trimmed, role);
      const link = `${window.location.origin}/invite/${invitation.token}`;
      setStatus({ type: 'success', message: link });
      setEmail('');
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create invitation' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <input
          style={styles.inlineInput}
          placeholder="Email to invite"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select style={styles.roleSelect} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="MEMBER">Member</option>
          <option value="MANAGER">Manager</option>
        </select>
        <button type="submit" style={styles.inviteSubmit}>Create link</button>
      </form>
      {status && (
        <div style={{ ...styles.inviteFeedback, ...(status.type === 'error' ? styles.inviteError : styles.inviteSuccess) }}>
          {status.type === 'success' ? (
            <>
              <span>{status.message}</span>{' '}
              <button
                type="button"
                style={styles.inviteSubmit}
                onClick={() => navigator.clipboard?.writeText(status.message)}
              >
                Copy
              </button>
            </>
          ) : (
            status.message
          )}
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
  onInviteToChannel,
  onLogout,
  canManageAi,
  onOpenAiSettings,
  onOpenAuditLog,
  onNavigateToSearchResult,
  onInviteMember,
  onCreateInviteLink,
  onOpenChangePassword,
  onOpenUserManagement,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onOpenBrowseWorkspaces,
  organizations,
  selectedOrganizationId,
  onSelectOrganization,
  isSystemAdmin,
  onOpenCreateOrganization,
  onOpenOrgManagement,
  onOpenSystemAdmin,
  onTransferOwnership,
  onChangeVisibility,
  onToggleManagersCanArchive,
  notificationSummary,
  onOpenNotifications,
}) {
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [inviteFormWorkspaceId, setInviteFormWorkspaceId] = useState(null);
  const [inviteLinkFormWorkspaceId, setInviteLinkFormWorkspaceId] = useState(null);
  const [transferFormWorkspaceId, setTransferFormWorkspaceId] = useState(null);
  const [inviteChannelFormId, setInviteChannelFormId] = useState(null);
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
    ...(currentOrg && hasOrgManagementAccess(isSystemAdmin, currentOrg.role)
      ? [{ key: 'manage-org', label: 'Manage organization members…', onSelect: onOpenOrgManagement }]
      : []),
  ];

  // Organization controls are only useful when there is a decision or an
  // admin action to make — a bare single-org switcher with one always-
  // checked, non-actionable entry is exactly the "database administration
  // surface" friction FEATURE_REQUEST.md entry 2 asks to de-emphasize.
  const showOrgRow =
    organizations.length > 1 ||
    isSystemAdmin ||
    Boolean(currentOrg && hasOrgManagementAccess(isSystemAdmin, currentOrg.role));

  const userMenuItems = [
    {
      key: 'mention-notifications',
      label: `Mentions${notificationSummary?.unreadCount ? ` (${notificationSummary.unreadCount})` : ''}`,
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

      {canManageAi && (
        <div style={styles.adminToolsRow}>
          <Menu
            ariaLabel="Admin tools"
            items={[
              { key: 'ai-settings', label: 'AI Settings', onSelect: onOpenAiSettings },
              { key: 'audit-log', label: 'Audit Log', onSelect: onOpenAuditLog },
              { key: 'manage-users', label: 'Manage Users', onSelect: onOpenUserManagement },
              // System Admin (FEATURE_REQUEST.md entry 1, slice 4): gated on
              // the plain isSystemAdmin prop, not canManageAi — a
              // workspace-admin-but-not-system-admin (this whole menu's own
              // canManageAi gate) must never see this item, since account
              // creation/disable and cross-org oversight are system-admin-only.
              ...(isSystemAdmin
                ? [{ key: 'system-admin', label: 'System Admin', separatorBefore: true, onSelect: onOpenSystemAdmin }]
                : []),
            ]}
            renderTrigger={(triggerProps) => (
              <button type="button" {...triggerProps} style={styles.aiSettingsButton}>
                <Settings size={14} aria-hidden="true" />
                Admin Tools
              </button>
            )}
          />
        </div>
      )}

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
          const workspaceMenuItems = [
            ...(canInvite
              ? [
                  { key: 'invite', label: 'Invite member…', onSelect: () => setInviteFormWorkspaceId(ws.id) },
                  { key: 'invite-link', label: 'Create invite link…', onSelect: () => setInviteLinkFormWorkspaceId(ws.id) },
                ]
              : []),
            ...(canArchive
              ? [{ key: 'archive', label: 'Archive workspace', separatorBefore: canInvite, onSelect: () => onArchiveWorkspace(ws.id) }]
              : []),
            ...(canTransferOwnership
              ? [
                  {
                    key: 'transfer-ownership',
                    label: 'Transfer ownership…',
                    separatorBefore: canInvite || canArchive,
                    onSelect: () => setTransferFormWorkspaceId(ws.id),
                  },
                ]
              : []),
            ...(canChangeVisibility
              ? [
                  {
                    key: 'change-visibility',
                    label: ws.visibility === 'DISCOVERABLE' ? 'Make invite-only' : 'Make listed',
                    onSelect: () => onChangeVisibility(ws.id, ws.visibility === 'DISCOVERABLE' ? 'PRIVATE' : 'DISCOVERABLE'),
                  },
                ]
              : []),
            ...(canManageSettings
              ? [
                  {
                    key: 'managers-can-archive',
                    label: 'Managers can archive',
                    checked: Boolean(ws.managersCanArchive),
                    onSelect: () => onToggleManagersCanArchive(ws.id, !ws.managersCanArchive),
                  },
                ]
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
                        <MoreHorizontal size={18} aria-hidden="true" />
                      </button>
                    )}
                  />
                )}
              </div>
              {inviteFormWorkspaceId === ws.id && (
                <InviteMemberForm workspaceId={ws.id} onSubmit={(username, role) => onInviteMember(ws.id, username, role)} />
              )}
              {inviteLinkFormWorkspaceId === ws.id && (
                <InviteLinkForm onSubmit={(email, role) => onCreateInviteLink(ws.id, email, role)} />
              )}
              {transferFormWorkspaceId === ws.id && (
                <TransferOwnershipForm workspaceId={ws.id} onSubmit={(username) => onTransferOwnership(ws.id, username)} />
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
        {showNewWorkspace ? (
          <InlineCreateForm
            placeholder="Workspace name"
            visibilityToggle={{
              label: 'Listed',
              hint: 'Listed workspaces can be joined by anyone in your organization. Invite-only workspaces require an invitation.',
              onValue: 'DISCOVERABLE',
              offValue: 'PRIVATE',
              defaultOn: false,
            }}
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
        )}

        {selectedWorkspaceId && (
          <>
            <div style={{ ...styles.sectionTitle, marginTop: 18 }}>
              Channels
              {isSelectedWorkspaceArchived && <span style={styles.archivedBadge}>(archived — read only)</span>}
            </div>
            {channels.map((ch) => {
              // Invite only makes sense for a PRIVATE channel the caller
              // already belongs to: a PUBLIC channel is already reachable via
              // the self-service "Join" pill above, and requireChannelMember
              // (backend/src/authz/membershipService.js) rejects the add-
              // member call from anyone who isn't already a member anyway, so
              // there's no point offering the control to a non-member.
              const canInviteToChannel = ch.isMember && ch.type === 'PRIVATE' && !isSelectedWorkspaceArchived;
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
                    {canInviteToChannel && (
                      <Menu
                        ariaLabel={`${ch.name} options`}
                        items={[
                          {
                            key: 'invite-to-channel',
                            label: 'Invite to channel…',
                            onSelect: () => setInviteChannelFormId(ch.id),
                          },
                        ]}
                        renderTrigger={({ onClick, ...triggerProps }) => (
                          <button
                            type="button"
                            {...triggerProps}
                            style={styles.overflowTrigger}
                            aria-label={`${ch.name} options`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onClick();
                            }}
                          >
                            <MoreHorizontal size={18} aria-hidden="true" />
                          </button>
                        )}
                      />
                    )}
                  </div>
                  {inviteChannelFormId === ch.id && (
                    <InviteToChannelForm
                      workspaceId={selectedWorkspaceId}
                      channelId={ch.id}
                      onSubmit={(username) => onInviteToChannel(ch.id, username)}
                    />
                  )}
                </div>
              );
            })}
            {!isSelectedWorkspaceArchived &&
              (showNewChannel ? (
                <InlineCreateForm
                  placeholder="Channel name"
                  visibilityToggle={{
                    label: (
                      <>
                        <Lock size={12} aria-hidden="true" /> Private
                      </>
                    ),
                    hint: 'Private channels are visible only to invited members. Open channels are visible to the whole workspace.',
                    onValue: 'PRIVATE',
                    offValue: 'PUBLIC',
                    defaultOn: false,
                  }}
                  onSubmit={(name, type) => {
                    onCreateChannel(name, type ?? 'PUBLIC');
                    setShowNewChannel(false);
                  }}
                />
              ) : (
                <button type="button" style={styles.addButton} onClick={() => setShowNewChannel(true)}>
                  <Plus size={14} aria-hidden="true" />
                  New channel
                </button>
              ))}
          </>
        )}
      </div>
    </aside>
  );
}
