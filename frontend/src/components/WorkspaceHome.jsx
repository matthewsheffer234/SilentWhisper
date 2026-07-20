import { useMemo, useState } from 'react';
import { Hash, Lock, Plus, UserPlus } from 'lucide-react';
import { TaskCheckbox } from '../markdown.jsx';
import { canSelfJoinChannel } from '../channels.js';

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
  // FEATURE_REQUEST.md entry 3: workspace task dashboard. A later, deliberate
  // addition of the "new dashboard query" this file's own header comment
  // originally avoided — bounded/paginated server-side (routes/tasks.js),
  // not the kind of unbounded activity feed that comment was steering away
  // from.
  segmentedControl: {
    display: 'inline-flex',
    borderRadius: 8,
    border: '1px solid var(--border)',
    overflow: 'hidden',
    marginTop: 8,
  },
  segmentButton: {
    minHeight: 44,
    padding: '0 16px',
    border: 'none',
    background: 'none',
    color: 'var(--text-3)',
    fontWeight: 600,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
  },
  segmentButtonActive: { background: 'var(--brg)', color: '#fff' },
  taskList: { listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  taskCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '4px 10px',
    borderRadius: 8,
    background: 'var(--surface-alt)',
    border: '1px solid var(--border)',
  },
  taskCardBody: { flex: 1, minWidth: 0, paddingTop: 11 },
  taskCardText: { fontSize: 'var(--text-sm)', color: 'var(--text-1)' },
  taskCardTextChecked: { color: 'var(--text-3)', textDecoration: 'line-through' },
  taskCardMeta: { fontSize: 'var(--text-xs)', color: 'var(--text-3)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' },
  taskEmptyText: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', margin: '12px 0 0' },
  // Same literal color ThreadSidebar.jsx's own AI-action error text already
  // uses — not a new convention.
  taskErrorText: { color: '#c0392b', fontSize: 'var(--text-sm)', margin: '12px 0 0' },
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
  currentUser,
  tasks,
  tasksLoading,
  tasksError,
  onToggleDashboardTask,
}) {
  const hasChannels = channels.length > 0;
  // FEATURE_REQUEST.md entry 3: "Tasks for Me" / "Tasks for Everyone Else",
  // matching the submitted spec exactly — "me" filters by owner username,
  // everyone-else is the complement (unassigned + assigned to anyone else),
  // not a third "unassigned" segment.
  const [taskSegment, setTaskSegment] = useState('me');
  const visibleTasks = useMemo(() => {
    const list = tasks ?? [];
    if (taskSegment === 'me') return list.filter((t) => t.owner === currentUser?.username);
    return list.filter((t) => t.owner !== currentUser?.username);
  }, [tasks, taskSegment, currentUser?.username]);

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
                    // ch.type check: a system admin's override view lists PRIVATE channels
                    // they aren't in too (isMember: false) — those 400 on self-join.
                    !archived &&
                    ch.type === 'PUBLIC' && (
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
        {/* FEATURE_REQUEST.md entry 3: a live projection of every task line
            (`- [ ] ... [owner:: @user]`) across the workspace's channels the
            caller can read — a durable list of what's open and who owns it,
            not a second system of record that can drift from channel
            content itself (recomputed server-side on every fetch/broadcast,
            routes/tasks.js). Read-only w.r.t. workspace archive state — same
            "doesn't require write access" reasoning the now-relocated Catch
            Me Up trigger (WorkspaceSidebar.jsx's workspace row) uses. */}
        {hasChannels && (
          <>
            <div style={styles.sectionTitle}>Tasks</div>
            <div style={styles.segmentedControl} role="tablist" aria-label="Task filter">
              <button
                type="button"
                role="tab"
                aria-selected={taskSegment === 'me'}
                style={{ ...styles.segmentButton, ...(taskSegment === 'me' ? styles.segmentButtonActive : {}) }}
                onClick={() => setTaskSegment('me')}
              >
                Tasks for Me
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={taskSegment === 'everyone-else'}
                style={{ ...styles.segmentButton, ...(taskSegment === 'everyone-else' ? styles.segmentButtonActive : {}) }}
                onClick={() => setTaskSegment('everyone-else')}
              >
                Tasks for Everyone Else
              </button>
            </div>

            {tasksError && <p style={styles.taskErrorText}>{tasksError}</p>}
            {!tasksError && tasksLoading && <p style={styles.taskEmptyText}>Loading tasks…</p>}
            {!tasksError && !tasksLoading && visibleTasks.length === 0 && (
              <p style={styles.taskEmptyText}>
                {taskSegment === 'me' ? 'No tasks assigned to you right now.' : 'No other open tasks right now.'}
              </p>
            )}
            {!tasksError && !tasksLoading && visibleTasks.length > 0 && (
              <ul style={styles.taskList}>
                {visibleTasks.map((t) => (
                  // Composite key, not just messageId — a single message can
                  // carry several task lines.
                  <li key={`${t.messageId}-${t.taskIndex}`} style={styles.taskCard}>
                    <TaskCheckbox
                      checked={t.checked}
                      onToggle={(nextChecked) => onToggleDashboardTask(t.channelId, t.messageId, t.taskIndex, nextChecked)}
                    />
                    <div style={styles.taskCardBody}>
                      <div style={{ ...styles.taskCardText, ...(t.checked ? styles.taskCardTextChecked : {}) }}>{t.text}</div>
                      <div style={styles.taskCardMeta}>
                        <button type="button" style={styles.openPill} onClick={() => onSelectChannel(t.channelId)}>
                          #{t.channelName}
                        </button>
                        {t.owner && <span>@{t.owner}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
