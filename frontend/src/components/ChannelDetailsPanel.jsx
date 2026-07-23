import { useEffect, useState } from 'react';
import { Hash, Lock } from 'lucide-react';
import Sheet from './Sheet.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import { UserPresenceBadge } from '../context/PresenceContext.jsx';
import Pager from './Pager.jsx';
import { listChannelMembers, searchWorkspaceMembers } from '../api/workspaces.js';

// FEATURE_REQUEST.md entry 2: GET .../channels/:channelId/members is now
// offset-paginated server-side.
const MEMBERS_PAGE_SIZE = 50;

// FEATURE_REQUEST.md's "channel details panel with private-channel member
// management" entry: makes channel membership a channel-level detail,
// reachable from the channel header. Originally shipped alongside the
// sidebar's own per-row "Invite to channel…" overflow item as a second entry
// point to the same underlying add-member action; the "navigation-first
// sidebar redesign" entry later removed that inline sidebar form, leaving
// this panel as the sole add-member surface.

const styles = {
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: 8,
  },
  metaRow: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-2)', fontSize: 'var(--text-sm)', marginBottom: 4 },
  contextRow: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginBottom: 16 },
  readOnlyNote: {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    background: 'var(--surface-alt)',
    borderRadius: 8,
    padding: '8px 10px',
    marginBottom: 16,
  },
  memberRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' },
  memberName: { fontSize: 'var(--text-sm)', color: 'var(--text-1)', flex: 1 },
  memberUsername: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)' },
  addRow: { display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 10 },
  addButton: {
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  removeButton: {
    minHeight: 28,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  renameRow: { display: 'flex', gap: 6, marginBottom: 4 },
  renameInput: {
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
  renameButton: {
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
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginTop: 8 },
  success: { color: 'var(--brg)', fontSize: 'var(--text-sm)', marginTop: 8 },
};

// FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"),
// Part 2 — channels had no rename path at all before this. Shown to any
// current channel member (matching the backend's own
// requireChannelMemberOrSystemAdmin gate — no PRIVATE-only restriction the
// way "Add people"/"Remove" below have, since renaming isn't a membership
// grant).
function RenameChannelSection({ channelName, onRename }) {
  const [name, setName] = useState(channelName);
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === channelName) return;
    setStatus(null);
    try {
      await onRename(trimmed);
      setStatus({ type: 'success', message: 'Renamed' });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to rename channel' });
    }
  }

  return (
    <div>
      <form style={styles.renameRow} onSubmit={handleSubmit}>
        <input
          style={styles.renameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Channel name"
          aria-label="Channel name"
        />
        <button type="submit" style={styles.renameButton} disabled={!name.trim() || name.trim() === channelName}>
          Rename
        </button>
      </form>
      {status && (
        <div style={status.type === 'error' ? styles.error : styles.success}>{status.message}</div>
      )}
    </div>
  );
}

export default function ChannelDetailsPanel({
  channel,
  workspaceId,
  workspaceName,
  canAddMembers,
  archived,
  onAddMember,
  onRemoveMember,
  onRename,
  onClose,
}) {
  const [members, setMembers] = useState(null);
  const [membersOffset, setMembersOffset] = useState(0);
  const [membersTotal, setMembersTotal] = useState(0);
  const [error, setError] = useState(null);
  const [person, setPerson] = useState(null);
  const [addStatus, setAddStatus] = useState(null);
  const [removeStatus, setRemoveStatus] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null); // member pending removal

  function loadMembers(offset = 0) {
    listChannelMembers(workspaceId, channel.id, { limit: MEMBERS_PAGE_SIZE, offset })
      .then((res) => {
        setMembers(res.members);
        setMembersOffset(res.offset);
        setMembersTotal(res.total);
      })
      .catch((err) => setError(err.message || 'Failed to load members'));
  }

  useEffect(() => {
    loadMembers(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, channel.id]);

  async function handleRemovePerson(member) {
    setRemoveStatus(null);
    try {
      await onRemoveMember(channel.id, member.userId);
      loadMembers(membersOffset);
    } catch (err) {
      setRemoveStatus({ type: 'error', message: err.message || 'Failed to remove member' });
    } finally {
      setConfirmRemove(null);
    }
  }

  async function handleAddPerson() {
    if (!person) return;
    setAddStatus(null);
    try {
      await onAddMember(channel.id, person.username);
      setAddStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the channel` });
      setPerson(null);
      loadMembers(membersOffset);
    } catch (err) {
      setAddStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  const isPrivate = channel.type === 'PRIVATE';
  const memberCount = channel.memberCount ?? membersTotal;

  return (
    <Sheet
      title={channel.name}
      ariaLabel={`${channel.name} channel details`}
      onClose={onClose}
      width={420}
      maxHeight="86vh"
    >
      <div style={styles.metaRow}>
        {isPrivate ? <Lock size={14} aria-hidden="true" /> : <Hash size={14} aria-hidden="true" />}
        <span>
          {isPrivate ? 'Private' : 'Open'} · {memberCount ?? '…'} member{memberCount === 1 ? '' : 's'}
        </span>
      </div>
      {workspaceName && <div style={styles.contextRow}>in {workspaceName}</div>}
      {archived && <div style={styles.readOnlyNote}>This workspace is archived — read only. Membership can't be changed.</div>}

      {channel.isMember && !archived && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Name</div>
          <RenameChannelSection channelName={channel.name} onRename={(name) => onRename(channel.id, name)} />
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Members</div>
        {error && <div style={styles.error}>{error}</div>}
        {removeStatus && <div style={styles.error}>{removeStatus.message}</div>}
        {!members && !error && <div style={styles.empty}>Loading…</div>}
        {members?.length === 0 && <div style={styles.empty}>No members yet.</div>}
        {members?.map((m) => (
          <div key={m.userId} style={styles.memberRow}>
            <UserPresenceBadge userId={m.userId} />
            <span style={styles.memberName}>
              {m.displayName || m.username}
              {m.displayName && m.displayName !== m.username && (
                <span style={styles.memberUsername}> @{m.username}</span>
              )}
            </span>
            {canAddMembers && !archived && (
              <button type="button" style={styles.removeButton} onClick={() => setConfirmRemove(m)}>
                Remove
              </button>
            )}
          </div>
        ))}
        <Pager offset={membersOffset} limit={MEMBERS_PAGE_SIZE} total={membersTotal} onPageChange={loadMembers} />
      </div>

      {canAddMembers && !archived && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Add people</div>
          <div style={styles.addRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <PeoplePicker
                searchFn={(q) => searchWorkspaceMembers(workspaceId, q, { channelId: channel.id })}
                value={person}
                onChange={setPerson}
                placeholder="Search workspace members to add"
                ariaLabel="Search workspace members to add to channel"
                isIneligible={(p) => (p.alreadyInChannel ? 'Already in this channel' : null)}
              />
            </div>
            <button type="button" style={styles.addButton} onClick={handleAddPerson} disabled={!person}>
              Add
            </button>
          </div>
          {addStatus && (
            <div style={addStatus.type === 'error' ? styles.error : styles.success}>{addStatus.message}</div>
          )}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove Member"
          message={`Remove ${confirmRemove.displayName || confirmRemove.username} from #${channel.name}? They will keep their workspace membership and can be re-added later.`}
          confirmLabel="Remove"
          onConfirm={() => handleRemovePerson(confirmRemove)}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </Sheet>
  );
}
