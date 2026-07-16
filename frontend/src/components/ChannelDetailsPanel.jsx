import { useEffect, useState } from 'react';
import { Hash, Lock } from 'lucide-react';
import Sheet from './Sheet.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import PresenceBadge from './PresenceBadge.jsx';
import { listChannelMembers, searchWorkspaceMembers } from '../api/workspaces.js';

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
  memberName: { fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
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
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginTop: 8 },
  success: { color: 'var(--brg)', fontSize: 'var(--text-sm)', marginTop: 8 },
};

export default function ChannelDetailsPanel({
  channel,
  workspaceId,
  workspaceName,
  presence,
  canAddMembers,
  archived,
  onAddMember,
  onClose,
}) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [person, setPerson] = useState(null);
  const [addStatus, setAddStatus] = useState(null);

  useEffect(() => {
    listChannelMembers(workspaceId, channel.id)
      .then(setMembers)
      .catch((err) => setError(err.message || 'Failed to load members'));
  }, [workspaceId, channel.id]);

  async function handleAddPerson() {
    if (!person) return;
    setAddStatus(null);
    try {
      await onAddMember(channel.id, person.username);
      setAddStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the channel` });
      setPerson(null);
      const refreshed = await listChannelMembers(workspaceId, channel.id);
      setMembers(refreshed);
    } catch (err) {
      setAddStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  const isPrivate = channel.type === 'PRIVATE';
  const memberCount = channel.memberCount ?? members?.length;

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

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Members</div>
        {error && <div style={styles.error}>{error}</div>}
        {!members && !error && <div style={styles.empty}>Loading…</div>}
        {members?.length === 0 && <div style={styles.empty}>No members yet.</div>}
        {members?.map((m) => (
          <div key={m.userId} style={styles.memberRow}>
            <PresenceBadge status={presence[m.userId] ?? 'offline'} />
            <span style={styles.memberName}>{m.displayName || m.username}</span>
            {m.displayName && m.displayName !== m.username && <span style={styles.memberUsername}>@{m.username}</span>}
          </div>
        ))}
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
    </Sheet>
  );
}
