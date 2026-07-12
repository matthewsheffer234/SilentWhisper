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
  userRow: {
    display: 'flex',
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
  joinPill: {
    fontSize: 'var(--text-xs)',
    color: 'var(--brg)',
    fontWeight: 600,
    border: 'none',
    background: 'none',
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
};

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
}) {
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);

  return (
    <aside style={styles.sidebar}>
      <div style={styles.userRow}>
        <span style={styles.username}>{user?.username}</span>
        <PresenceBadge status={presence[user?.id] ?? 'online'} />
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
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Workspaces</div>
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className="sl-row"
            role="button"
            tabIndex={0}
            style={{ ...styles.row, ...(ws.id === selectedWorkspaceId ? styles.rowActive : {}) }}
            onClick={() => onSelectWorkspace(ws.id)}
            onKeyDown={activateOnKey(() => onSelectWorkspace(ws.id))}
          >
            {ws.name}
          </div>
        ))}
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

        {selectedWorkspaceId && (
          <>
            <div style={{ ...styles.sectionTitle, marginTop: 18 }}>Channels</div>
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
                {!ch.isMember && (
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
            {showNewChannel ? (
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
            )}
          </>
        )}
      </div>
    </aside>
  );
}
