import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { PERMISSIONS, hasPermission } from '../authz/permissions.js';
import {
  searchWorkspaceMembers,
  searchWorkspacePeople,
  listChannels,
  createChannel,
  listChannelMembers,
  addChannelMember,
} from '../api/workspaces.js';

// FEATURE_REQUEST.md's "dedicated admin/settings area" entry: consolidates
// what used to be five separate items in the workspace row's own overflow
// menu (Invite member…, Create invite link…, Transfer ownership…, the
// visibility-toggle label, and the managers-can-archive checkbox) plus the
// Archive action into one workspace-scoped settings surface, reached via a
// single "Workspace settings…" entry. Member roster/role/removal/password
// reset stays in UserManagementPanel.jsx, reachable from the separate Admin
// hub — a deliberate split confirmed with the user rather than merging
// everything into one panel, so this sheet only ever needs the specific
// workspace it was opened for, no workspace picker of its own.
const styles = {
  sectionTitle: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)', margin: '18px 0 8px' },
  sectionTitleFirst: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)', margin: '0 0 8px' },
  hint: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.4 },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  valueText: { fontSize: 'var(--text-sm)', color: 'var(--text-1)', flex: 1 },
  inlineForm: { display: 'flex', gap: 6, marginBottom: 6 },
  inlineInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  roleSelect: {
    minHeight: 40,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  actionButton: {
    minHeight: 40,
    padding: '0 14px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  secondaryButton: {
    minHeight: 40,
    padding: '0 14px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  dangerButton: {
    minHeight: 40,
    padding: '0 14px',
    borderRadius: 6,
    border: '1px solid #c0392b',
    background: 'none',
    color: '#c0392b',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  feedback: { fontSize: 'var(--text-xs)', marginTop: 4 },
  error: { color: '#c0392b' },
  success: { color: 'var(--brg)' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-1)', cursor: 'pointer' },
  divider: { border: 'none', borderTop: '1px solid var(--border)', margin: '18px 0' },
};

function InviteMemberSection({ workspaceId, onInviteMember, onInviteMembership }) {
  const [person, setPerson] = useState(null);
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setStatus(null);
    try {
      await onInviteMember(person.username, role);
      setStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the workspace` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  // FEATURE_REQUEST.md "Live notification system...": proposes membership
  // instead of adding it immediately — notified live, left pending until the
  // recipient accepts or declines. Shares the same person/role selection as
  // the instant-add submit above, just a different action.
  async function handleInvite() {
    if (!person) return;
    setStatus(null);
    try {
      await onInviteMembership(person.userId, role);
      setStatus({ type: 'success', message: `Invited ${person.displayName || person.username} — pending their acceptance` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to send invitation' });
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
        <button type="submit" style={styles.actionButton} disabled={!person}>Add</button>
        <button type="button" style={styles.secondaryButton} disabled={!person} onClick={handleInvite}>
          Invite (needs acceptance)
        </button>
      </form>
      {status && (
        <div style={{ ...styles.feedback, ...(status.type === 'error' ? styles.error : styles.success) }}>{status.message}</div>
      )}
    </div>
  );
}

function InviteLinkSection({ onCreateInviteLink }) {
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      const invitation = await onCreateInviteLink(role);
      const link = `${window.location.origin}/invite/${invitation.token}`;
      setStatus({ type: 'success', message: link });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create invitation' });
    }
  }

  return (
    <div>
      <form style={styles.inlineForm} onSubmit={handleSubmit}>
        <select style={styles.roleSelect} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="MEMBER">Member</option>
          <option value="MANAGER">Manager</option>
        </select>
        <button type="submit" style={styles.actionButton}>Create link</button>
      </form>
      {status && (
        <div style={{ ...styles.feedback, ...(status.type === 'error' ? styles.error : styles.success) }}>
          {status.type === 'success' ? (
            <>
              <span>{status.message}</span>{' '}
              <button type="button" style={styles.secondaryButton} onClick={() => navigator.clipboard?.writeText(status.message)}>
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

// A successful transfer demotes the caller to Manager, which flips
// `canTransferOwnership` false on the very next re-render (the workspace
// list refetch in ChatShell.jsx's handleTransferOwnership) — that unmounts
// this whole section, taking any local "Ownership transferred" success
// message down with it before it could ever be seen. Closing the entire
// sheet on success (via `onClose`, the same "destructive/high-impact
// action closing on success" pattern the Archive section below already
// uses) sidesteps that outright rather than trying to keep a doomed
// component's state alive.
function TransferOwnershipSection({ workspaceId, workspaceName, onTransferOwnership, onClose }) {
  const [person, setPerson] = useState(null);
  const [confirming, setConfirming] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setConfirming(person);
  }

  async function handleConfirm() {
    await onTransferOwnership(confirming.username);
    onClose();
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
        <button type="submit" style={styles.actionButton} disabled={!person}>Transfer</button>
      </form>
      {confirming && (
        <ConfirmDialog
          title="Transfer Ownership"
          message={`Transfer ownership of "${workspaceName}" to ${confirming.displayName || confirming.username}? You will become a Manager and lose owner-only controls such as archiving and future ownership transfers.`}
          confirmLabel="Transfer"
          onConfirm={handleConfirm}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function AdminChannelMembersSection({ workspaceId, channelId }) {
  const [members, setMembers] = useState([]);
  const [person, setPerson] = useState(null);
  const [status, setStatus] = useState(null);

  function loadMembers() {
    listChannelMembers(workspaceId, channelId)
      .then((res) => setMembers(res.members))
      .catch(() => {});
  }

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function handleAdd() {
    if (!person) return;
    setStatus(null);
    try {
      await addChannelMember(workspaceId, channelId, person.username);
      setStatus({ type: 'success', message: `Added ${person.displayName || person.username}` });
      setPerson(null);
      loadMembers();
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  return (
    <div style={{ marginLeft: 16, marginBottom: 12 }}>
      {members.map((m) => (
        <div key={m.userId} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-3)', padding: '2px 0' }}>
          {m.displayName || m.username}
        </div>
      ))}
      <div style={{ ...styles.inlineForm, marginTop: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PeoplePicker
            searchFn={(q) => searchWorkspaceMembers(workspaceId, q, { channelId })}
            value={person}
            onChange={setPerson}
            placeholder="Add an existing workspace member"
            ariaLabel="Search workspace members to add to channel"
            isIneligible={(p) => (p.alreadyInChannel ? 'Already in this channel' : null)}
          />
        </div>
        <button type="button" style={styles.actionButton} disabled={!person} onClick={handleAdd}>
          Add
        </button>
      </div>
      {status && (
        <div style={{ ...styles.feedback, ...(status.type === 'error' ? styles.error : styles.success) }}>{status.message}</div>
      )}
    </div>
  );
}

function CreateChannelForm({ onCreate }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('PUBLIC');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setStatus(null);
    try {
      await onCreate(name.trim(), type);
      setName('');
      setStatus({ type: 'success', message: 'Channel created' });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create channel' });
    }
  }

  return (
    <form style={styles.inlineForm} onSubmit={handleSubmit}>
      <input
        style={styles.inlineInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New channel name"
        aria-label="New channel name"
      />
      <select style={styles.roleSelect} value={type} onChange={(e) => setType(e.target.value)} aria-label="Channel type">
        <option value="PUBLIC">Public</option>
        <option value="PRIVATE">Private</option>
      </select>
      <button type="submit" style={styles.actionButton} disabled={!name.trim()}>
        Create
      </button>
      {status && (
        <div style={{ ...styles.feedback, ...(status.type === 'error' ? styles.error : styles.success) }}>{status.message}</div>
      )}
    </form>
  );
}

// System-admin-only surface (FEATURE_REQUEST.md: "any system admin should be
// able to fully manage all workspaces"): channel creation and channel-
// membership management for a workspace the admin isn't a member of. A
// plain member never sees this section — they already manage channels
// through the main sidebar/ChatShell flow (New channel, ChannelDetailsPanel),
// which this deliberately doesn't duplicate. Structural only, matching
// requireWorkspaceMemberOrSystemAdmin's own documented boundary
// (backend/src/authz/membershipService.js): this lists/creates channels and
// manages who's in them, but never shows a single message — there is no
// message-content surface anywhere in this admin path.
function AdminChannelManagementSection({ workspaceId }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedChannelId, setExpandedChannelId] = useState(null);

  function loadChannels() {
    setLoading(true);
    setError(null);
    listChannels(workspaceId)
      .then(setChannels)
      .catch((err) => setError(err.message || 'Failed to load channels'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function handleCreateChannel(name, type) {
    await createChannel(workspaceId, name, type);
    loadChannels();
  }

  return (
    <div>
      {loading && <div style={styles.hint}>Loading channels…</div>}
      {error && <div style={{ ...styles.feedback, ...styles.error }}>{error}</div>}
      {!loading && !error && channels.length === 0 && <div style={styles.hint}>No channels yet.</div>}
      {!loading &&
        channels.map((ch) => (
          <div key={ch.id}>
            <div style={styles.row}>
              <span style={styles.valueText}>
                {ch.type === 'PRIVATE' ? '🔒' : '#'} {ch.name} — {ch.memberCount} member{ch.memberCount === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => setExpandedChannelId(expandedChannelId === ch.id ? null : ch.id)}
              >
                {expandedChannelId === ch.id ? 'Hide' : 'Manage members'}
              </button>
            </div>
            {expandedChannelId === ch.id && <AdminChannelMembersSection workspaceId={workspaceId} channelId={ch.id} />}
          </div>
        ))}
      <div style={{ marginTop: 10 }}>
        <CreateChannelForm onCreate={handleCreateChannel} />
      </div>
    </div>
  );
}

export default function WorkspaceSettingsSheet({
  workspace,
  onClose,
  onInviteMember,
  onInviteMembership,
  onCreateInviteLink,
  onTransferOwnership,
  onChangeVisibility,
  onToggleManagersCanArchive,
  onArchiveWorkspace,
  // FEATURE_REQUEST.md: "any system admin should be able to fully manage
  // all workspaces." Set when this sheet is opened from SystemAdminPanel.jsx
  // for a workspace the caller isn't a member of (workspace.role is null in
  // that case, so hasPermission(...) alone would hide every section) —
  // every server-side route these sections call already grants a system
  // admin the same access via requireWorkspacePermission's own bypass
  // (backend/src/authz/membershipService.js), so this only unlocks UI that
  // the backend was already going to accept.
  isSystemAdminOverride = false,
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const canInvite = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS) || isSystemAdminOverride;
  const canArchive = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_ARCHIVE) || isSystemAdminOverride;
  const canTransferOwnership = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP) || isSystemAdminOverride;
  const canChangeVisibility = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY) || isSystemAdminOverride;
  const canManageSettings = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_MANAGE_SETTINGS) || isSystemAdminOverride;

  let firstSection = true;
  function sectionTitleStyle() {
    const style = firstSection ? styles.sectionTitleFirst : styles.sectionTitle;
    firstSection = false;
    return style;
  }

  return (
    <Sheet
      title="Workspace Settings"
      ariaLabel={`${workspace.name} settings`}
      subtitle={workspace.name}
      onClose={onClose}
      width={520}
      maxHeight="86vh"
    >
      {canChangeVisibility && (
        <>
          <div style={sectionTitleStyle()}>Visibility</div>
          <div style={styles.row}>
            <span style={styles.valueText}>
              {workspace.visibility === 'DISCOVERABLE'
                ? 'Listed — anyone in the organization can find and join.'
                : 'Invite-only — only invited people can join.'}
            </span>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => onChangeVisibility(workspace.visibility === 'DISCOVERABLE' ? 'PRIVATE' : 'DISCOVERABLE')}
            >
              {workspace.visibility === 'DISCOVERABLE' ? 'Make invite-only' : 'Make listed'}
            </button>
          </div>
        </>
      )}

      {isSystemAdminOverride && (
        <>
          <div style={sectionTitleStyle()}>Channels</div>
          <div style={styles.hint}>
            Structural management only — creating channels and adding people to them, never reading their messages.
          </div>
          <AdminChannelManagementSection workspaceId={workspace.id} />
        </>
      )}

      {canManageSettings && (
        <>
          <div style={sectionTitleStyle()}>Archiving permissions</div>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={Boolean(workspace.managersCanArchive)}
              onChange={(e) => onToggleManagersCanArchive(e.target.checked)}
            />
            Managers can archive this workspace
          </label>
        </>
      )}

      {canInvite && (
        <>
          <div style={sectionTitleStyle()}>Invite an existing member</div>
          <InviteMemberSection workspaceId={workspace.id} onInviteMember={onInviteMember} onInviteMembership={onInviteMembership} />

          <div style={styles.sectionTitle}>Create an invite link</div>
          <div style={styles.hint}>For someone who doesn't have an account yet — share the link with them yourself.</div>
          <InviteLinkSection onCreateInviteLink={onCreateInviteLink} />
        </>
      )}

      {canTransferOwnership && (
        <>
          <div style={sectionTitleStyle()}>Transfer ownership</div>
          <div style={styles.hint}>You will become a Manager once the transfer completes.</div>
          <TransferOwnershipSection
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            onTransferOwnership={onTransferOwnership}
            onClose={onClose}
          />
        </>
      )}

      {canArchive && (
        <>
          <hr style={styles.divider} />
          <div style={styles.sectionTitle}>Archive this workspace</div>
          <div style={styles.hint}>
            Members keep read access to existing messages, but no one can post, create channels, or invite anyone until it's
            unarchived.
          </div>
          <button type="button" style={styles.dangerButton} onClick={() => setConfirmingArchive(true)}>
            Archive workspace
          </button>
        </>
      )}

      {confirmingArchive && (
        <ConfirmDialog
          title="Archive Workspace"
          message={`Archive "${workspace.name}"? Members will keep read access to existing messages, but no one will be able to post, create channels, or invite anyone until it's unarchived.`}
          confirmLabel="Archive"
          onConfirm={async () => {
            await onArchiveWorkspace();
            onClose();
          }}
          onClose={() => setConfirmingArchive(false)}
        />
      )}
    </Sheet>
  );
}
