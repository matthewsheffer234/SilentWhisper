import { useState } from 'react';
import Sheet from './Sheet.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { PERMISSIONS, hasPermission } from '../authz/permissions.js';
import { searchWorkspaceMembers, searchWorkspacePeople } from '../api/workspaces.js';

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

function InviteMemberSection({ workspaceId, onInviteMember }) {
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
      </form>
      {status && (
        <div style={{ ...styles.feedback, ...(status.type === 'error' ? styles.error : styles.success) }}>{status.message}</div>
      )}
    </div>
  );
}

function InviteLinkSection({ onCreateInviteLink }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus(null);
    try {
      const invitation = await onCreateInviteLink(trimmed, role);
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

export default function WorkspaceSettingsSheet({
  workspace,
  onClose,
  onInviteMember,
  onCreateInviteLink,
  onTransferOwnership,
  onChangeVisibility,
  onToggleManagersCanArchive,
  onArchiveWorkspace,
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const canInvite = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS);
  const canArchive = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_ARCHIVE);
  const canTransferOwnership = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_TRANSFER_OWNERSHIP);
  const canChangeVisibility = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_CHANGE_VISIBILITY);
  const canManageSettings = hasPermission(workspace.role, PERMISSIONS.WORKSPACE_MANAGE_SETTINGS);

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
          <InviteMemberSection workspaceId={workspace.id} onInviteMember={onInviteMember} />

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
