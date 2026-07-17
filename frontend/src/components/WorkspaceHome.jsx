import { Hash, Lock, Plus, UserPlus, Sparkles } from 'lucide-react';

// FEATURE_REQUEST.md's "workspace home and actionable empty states" entry:
// replaces ChannelView.jsx's plain "Select a channel to get started." text
// (rendered whenever no channel is selected) with an actual overview of the
// *workspace* that is selected — name, archived/read-only state, the
// channel list, and the next likely actions — once a workspace exists to
// show one for. Deliberately uses only already-loaded `workspace`/`channels`
// data (both already fetched for the sidebar) rather than a new dashboard
// query, per the entry's own "avoid a heavy query" guidance — recent-
// activity content was left out for exactly this reason, not forgotten.
const styles = {
  wrapper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: 'var(--surface)',
    overflowY: 'auto',
  },
  content: { maxWidth: 560, margin: '0 auto', padding: '48px 24px', width: '100%', boxSizing: 'border-box' },
  title: { fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-1)', margin: 0 },
  archivedNote: {
    marginTop: 10,
    padding: '10px 14px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    color: 'var(--text-3)',
    fontSize: 'var(--text-sm)',
  },
  sectionTitle: {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-3)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    margin: '32px 0 10px',
  },
  firstRunText: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', margin: '16px 0 0' },
  channelList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  channelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
  },
  channelName: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  channelMeta: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
  actions: { display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' },
  primaryButton: {
    minHeight: 44,
    padding: '0 18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  secondaryButton: {
    minHeight: 44,
    padding: '0 18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  joinPill: {
    minHeight: 32,
    padding: '0 12px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
  openPill: {
    minHeight: 32,
    padding: '0 12px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-1)',
    fontWeight: 600,
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
};

export default function WorkspaceHome({
  mainContentId,
  workspace,
  channels,
  archived,
  canInvite,
  onSelectChannel,
  onJoinChannel,
  onCreateChannel,
  onOpenWorkspaceSettings,
  onOpenDigest,
}) {
  const hasChannels = channels.length > 0;

  return (
    <div id={mainContentId} tabIndex={-1} style={styles.wrapper}>
      <div style={styles.content}>
        <h1 style={styles.title}>{workspace.name}</h1>
        {archived && (
          <div style={styles.archivedNote}>
            This workspace is archived — read only. Existing messages remain visible, but no one can post, create channels, or
            invite anyone until it's unarchived.
          </div>
        )}

        {!hasChannels ? (
          // First-run state (FEATURE_REQUEST.md's own wording): a brand-new
          // workspace has nothing to list yet, so the priority is getting
          // the first channel created, not an empty list with a caption.
          <p style={styles.firstRunText}>
            {archived ? 'This workspace has no channels.' : "This workspace doesn't have any channels yet — create the first one to get started."}
          </p>
        ) : (
          <>
            <div style={styles.sectionTitle}>Channels</div>
            <ul style={styles.channelList}>
              {channels.map((ch) => (
                <li key={ch.id} style={styles.channelRow}>
                  <span style={styles.channelName}>
                    {ch.type === 'PRIVATE' ? <Lock size={14} aria-hidden="true" /> : <Hash size={14} aria-hidden="true" />}
                    {ch.name}
                  </span>
                  {typeof ch.memberCount === 'number' && (
                    <span style={styles.channelMeta}>
                      {ch.memberCount} {ch.memberCount === 1 ? 'member' : 'members'}
                    </span>
                  )}
                  {ch.isMember ? (
                    <button type="button" style={styles.openPill} onClick={() => onSelectChannel(ch.id)}>
                      Open
                    </button>
                  ) : (
                    !archived && (
                      <button type="button" style={styles.joinPill} onClick={() => onJoinChannel(ch.id)}>
                        Join
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Permission-aware: a non-admin member never sees a disabled
            "Invite People" control here, since they never see it at all —
            the same hide-rather-than-disable convention this app already
            uses for the sidebar's own workspace-scoped controls. */}
        {!archived && (
          <div style={styles.actions}>
            <button type="button" style={styles.primaryButton} onClick={onCreateChannel}>
              <Plus size={14} aria-hidden="true" />
              {hasChannels ? 'Create Channel' : 'Create your first channel'}
            </button>
            {canInvite && (
              <button type="button" style={styles.secondaryButton} onClick={onOpenWorkspaceSettings}>
                <UserPlus size={14} aria-hidden="true" />
                {hasChannels ? 'Invite People' : 'Invite teammates'}
              </button>
            )}
          </div>
        )}
        {/* Read-only, so shown regardless of archived state — unlike Create
            Channel/Invite People above, generating a digest doesn't require
            write access to the workspace. FEATURE_REQUEST.md entry 6. */}
        {hasChannels && (
          <div style={styles.actions}>
            <button type="button" style={styles.secondaryButton} onClick={onOpenDigest}>
              <Sparkles size={14} aria-hidden="true" />
              Catch Me Up
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
