import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { createSocket } from '../ws/socket.js';
import * as workspacesApi from '../api/workspaces.js';
import WorkspaceSidebar from './WorkspaceSidebar.jsx';
import ChannelView from './ChannelView.jsx';
import ThreadSidebar from './ThreadSidebar.jsx';
import AiSettingsPanel from './AiSettingsPanel.jsx';
import AuditDashboard from './AuditDashboard.jsx';
import ChangePasswordPanel from './ChangePasswordPanel.jsx';
import UserManagementPanel from './UserManagementPanel.jsx';
import mentionIcon from '../assets/mention-icon.svg';

const styles = {
  shell: { display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' },
  // Fixed, top-right — never obscures the composer or sidebar. No
  // transition/animation, matching every other panel in this app (none of
  // AiSettingsPanel/AuditDashboard animate either), which sidesteps needing
  // a separate prefers-reduced-motion branch for this one surface.
  mentionToastContainer: {
    position: 'fixed',
    top: 12,
    right: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    zIndex: 60,
    maxWidth: 320,
  },
  mentionToast: {
    padding: '10px 14px',
    borderRadius: 10,
    background: 'var(--surface)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
    border: '1px solid var(--border)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-1)',
  },
  mentionToastAuthor: { fontWeight: 700 },
};

function toDisplayMessage(m) {
  return { ...m, pending: false };
}

export default function ChatShell() {
  const { user, logout } = useAuth();

  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [joinedChannels, setJoinedChannels] = useState(() => new Set());
  const [messagesByChannel, setMessagesByChannel] = useState({});
  const [presence, setPresence] = useState({});
  const [threadRoot, setThreadRoot] = useState(null);
  const [threadReplies, setThreadReplies] = useState([]);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [userManagementOpen, setUserManagementOpen] = useState(false);
  const [mentionToasts, setMentionToasts] = useState([]);

  const socketRef = useRef(null);
  const selectedChannelIdRef = useRef(null);
  const threadRootRef = useRef(null);
  selectedChannelIdRef.current = selectedChannelId;
  threadRootRef.current = threadRoot;

  const reconcileMessage = useCallback((channelId, incoming) => {
    setMessagesByChannel((prev) => {
      const existing = prev[channelId] ?? [];
      const nonceMatchIndex = incoming.clientNonce ? existing.findIndex((m) => m.id === incoming.clientNonce) : -1;
      let next;
      if (nonceMatchIndex !== -1) {
        next = [...existing];
        next[nonceMatchIndex] = toDisplayMessage(incoming.message);
      } else if (existing.some((m) => m.id === incoming.message.id)) {
        return prev;
      } else {
        next = [...existing, toDisplayMessage(incoming.message)];
      }
      return { ...prev, [channelId]: next };
    });
  }, []);

  const reconcileThreadReply = useCallback((incoming) => {
    setThreadReplies((prev) => {
      const nonceMatchIndex = incoming.clientNonce ? prev.findIndex((m) => m.id === incoming.clientNonce) : -1;
      if (nonceMatchIndex !== -1) {
        const next = [...prev];
        next[nonceMatchIndex] = toDisplayMessage(incoming.message);
        return next;
      }
      if (prev.some((m) => m.id === incoming.message.id)) return prev;
      return [...prev, toDisplayMessage(incoming.message)];
    });
  }, []);

  // Socket lifecycle: one connection for the lifetime of the authenticated
  // session (PROJECT_PLAN.md Section 8, Phase 3).
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('authenticated', (frame) => {
      setPresence((prev) => ({ ...prev, ...frame.presence }));
      // Re-join whatever channel is currently selected — covers both first
      // connect and any reconnect, which always re-validates membership
      // server-side rather than trusting a prior session (Section 3).
      if (selectedChannelIdRef.current) {
        socket.send({ type: 'join', channelId: selectedChannelIdRef.current });
      }
    });

    socket.on('joined', (frame) => {
      setJoinedChannels((prev) => new Set(prev).add(frame.channelId));
    });

    socket.on('presence_update', (frame) => {
      setPresence((prev) => ({ ...prev, [frame.userId]: frame.status }));
    });

    socket.on('message_created', (frame) => {
      if (frame.message.parentMessageId) {
        if (threadRootRef.current && frame.message.parentMessageId === threadRootRef.current.id) {
          reconcileThreadReply(frame);
        }
        return;
      }
      reconcileMessage(frame.message.channelId, frame);
    });

    // A mention frame is a side effect of message creation on the backend
    // (Section 8, Phase 6), delivered to every open connection for the
    // mentioned user regardless of which channel/room they currently have
    // joined. The in-app toast always fires; the OS notification is an
    // enhancement layered on top, gated on both permission and the tab
    // being unfocused — an already-visible tab doesn't need an OS popup on
    // top of what's already on screen.
    socket.on('mention', (frame) => {
      const toastId = crypto.randomUUID();
      setMentionToasts((prev) => [...prev, { id: toastId, mentionedBy: frame.mentionedBy, content: frame.message.content }]);
      setTimeout(() => {
        setMentionToasts((prev) => prev.filter((t) => t.id !== toastId));
      }, 6000);

      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        window.Notification.permission === 'granted' &&
        !document.hasFocus()
      ) {
        // Locally bundled asset (imported the normal Vite way, rewritten to
        // a bundled, content-hashed path at build time), never a remote
        // URL — Section 9, no runtime asset fetches.
        const notification = new window.Notification(`${frame.mentionedBy} mentioned you`, {
          body: frame.message.content,
          icon: mentionIcon,
        });
        notification.onclick = () => window.focus();
      }
    });

    socket.on('disconnected', () => setJoinedChannels(new Set()));

    socket.connect();
    return () => socket.disconnect();
  }, [reconcileMessage, reconcileThreadReply]);

  useEffect(() => {
    workspacesApi.listWorkspaces().then((ws) => {
      setWorkspaces(ws);
      if (ws.length > 0) setSelectedWorkspaceId(ws[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    workspacesApi.listChannels(selectedWorkspaceId).then(setChannels);
  }, [selectedWorkspaceId]);

  const selectChannel = useCallback(
    (channelId) => {
      setSelectedChannelId(channelId);
      setThreadRoot(null);
      if (!messagesByChannel[channelId]) {
        workspacesApi.listMessages(channelId).then((history) => {
          // Server returns newest-first; the feed displays oldest-first.
          const ordered = [...history].reverse().map(toDisplayMessage);
          setMessagesByChannel((prev) => ({ ...prev, [channelId]: ordered }));
        });
      }
      if (!joinedChannels.has(channelId)) {
        socketRef.current?.send({ type: 'join', channelId });
      }
    },
    [messagesByChannel, joinedChannels],
  );

  async function handleCreateWorkspace(name) {
    const ws = await workspacesApi.createWorkspace(name);
    setWorkspaces((prev) => [...prev, ws]);
    setSelectedWorkspaceId(ws.id);
  }

  async function handleCreateChannel(name, type) {
    const ch = await workspacesApi.createChannel(selectedWorkspaceId, name, type);
    setChannels((prev) => [...prev, { ...ch, isMember: true }]);
    selectChannel(ch.id);
  }

  function handleInviteMember(workspaceId, username, role) {
    return workspacesApi.inviteWorkspaceMember(workspaceId, username, role);
  }

  async function handleArchiveWorkspace(workspaceId) {
    const { archivedAt } = await workspacesApi.archiveWorkspace(workspaceId);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, archivedAt } : ws)));
  }

  async function handleUnarchiveWorkspace(workspaceId) {
    await workspacesApi.unarchiveWorkspace(workspaceId);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, archivedAt: null } : ws)));
  }

  async function handleJoinChannel(channelId) {
    await workspacesApi.joinChannel(selectedWorkspaceId, channelId);
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, isMember: true } : c)));
    selectChannel(channelId);
  }

  function handleSend(content) {
    const clientNonce = crypto.randomUUID();
    const optimistic = {
      id: clientNonce,
      channelId: selectedChannelId,
      userId: user.id,
      username: user.username,
      content,
      parentMessageId: null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessagesByChannel((prev) => ({
      ...prev,
      [selectedChannelId]: [...(prev[selectedChannelId] ?? []), optimistic],
    }));
    socketRef.current?.send({ type: 'message', channelId: selectedChannelId, content, clientNonce });
  }

  function openThread(rootMessage) {
    setThreadRoot(rootMessage);
    workspacesApi.listMessages(selectedChannelId, { parentMessageId: rootMessage.id }).then((history) => {
      setThreadReplies([...history].reverse().map(toDisplayMessage));
    });
  }

  function handleSendReply(content) {
    const clientNonce = crypto.randomUUID();
    const optimistic = {
      id: clientNonce,
      channelId: selectedChannelId,
      userId: user.id,
      username: user.username,
      content,
      parentMessageId: threadRoot.id,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setThreadReplies((prev) => [...prev, optimistic]);
    socketRef.current?.send({
      type: 'message',
      channelId: selectedChannelId,
      content,
      parentMessageId: threadRoot.id,
      clientNonce,
    });
  }

  // FEATURE_REQUEST.md entry 1 (semantic search): the search route already
  // includes the thread root (parentMessage) on a reply hit, so opening the
  // thread here needs no extra fetch — openThread only ever reads
  // rootMessage.id/username/content. workspaceId is left untouched when a
  // hit has none (DM/group-DM channels, workspace_id nullable per schema) —
  // selectChannel still works, it just isn't reflected in the sidebar's
  // currently-selected-workspace highlight, a pre-existing gap (no DM-
  // browsing UI exists yet) this inherits rather than introduces. Called
  // from SearchBar (the HIG overhaul entry's persistent search field), which
  // closes/resets its own popover state itself on navigate — this function
  // only owns cross-component navigation, not that component's local UI state.
  function handleNavigateToSearchResult(hit) {
    if (hit.workspaceId && hit.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(hit.workspaceId);
    }
    selectChannel(hit.channelId);
    if (hit.parentMessage) {
      openThread(hit.parentMessage);
    }
  }

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;
  // The AI settings surface is admin-only (PROJECT_PLAN.md Section 6); the
  // backend gates it on "ADMIN in at least one workspace" (Section 8, Phase
  // 4 — see requireAnyWorkspaceAdmin's doc comment), so the entry point
  // mirrors that same rule rather than the currently-selected workspace's
  // role.
  const canManageAi = workspaces.some((ws) => ws.role === 'ADMIN');
  const isSelectedWorkspaceArchived = Boolean(workspaces.find((ws) => ws.id === selectedWorkspaceId)?.archivedAt);

  return (
    <div style={styles.shell}>
      <WorkspaceSidebar
        user={user}
        presence={presence}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={setSelectedWorkspaceId}
        onCreateWorkspace={handleCreateWorkspace}
        channels={channels}
        selectedChannelId={selectedChannelId}
        onSelectChannel={selectChannel}
        onCreateChannel={handleCreateChannel}
        onJoinChannel={handleJoinChannel}
        onLogout={logout}
        canManageAi={canManageAi}
        onOpenAiSettings={() => setAiSettingsOpen(true)}
        onOpenAuditLog={() => setAuditLogOpen(true)}
        onNavigateToSearchResult={handleNavigateToSearchResult}
        onInviteMember={handleInviteMember}
        onOpenChangePassword={() => setChangePasswordOpen(true)}
        onOpenUserManagement={() => setUserManagementOpen(true)}
        onArchiveWorkspace={handleArchiveWorkspace}
        onUnarchiveWorkspace={handleUnarchiveWorkspace}
      />
      {/* PROJECT_PLAN.md Section 7 (Apple HIG Alignment) / Section 8 Phase 5
          accessibility pass: index.html's static skip link (present on
          every page, before React even mounts) has pointed at `#main`
          since Phase 1, but no element with that id existed anywhere —
          a genuinely dead skip link this pass caught and fixes here rather
          than by adding a second, competing skip link. The id/tabIndex live
          directly on ChannelView's own wrapper (via mainContentId), not on
          an extra `display: contents` div around it — that combination
          (tabIndex on a boxless element) turned out to break Chromium's
          *entire page's* Tab-key sequential focus order, not just this one
          element's own focusability: the skip link itself remained
          perfectly focusable via script, just unreachable by pressing Tab
          at all, anywhere on the page. Caught by the accessibility e2e
          test, not by eye. */}
      <ChannelView
        mainContentId="main"
        channel={selectedChannel}
        messages={messagesByChannel[selectedChannelId] ?? []}
        presence={presence}
        currentUser={user}
        joined={joinedChannels.has(selectedChannelId)}
        archived={isSelectedWorkspaceArchived}
        onSend={handleSend}
        onOpenThread={openThread}
      />
      <ThreadSidebar
        rootMessage={threadRoot}
        replies={threadReplies}
        presence={presence}
        currentUser={user}
        onSendReply={handleSendReply}
        onClose={() => setThreadRoot(null)}
      />
      {aiSettingsOpen && <AiSettingsPanel onClose={() => setAiSettingsOpen(false)} />}
      {auditLogOpen && <AuditDashboard onClose={() => setAuditLogOpen(false)} />}
      {changePasswordOpen && <ChangePasswordPanel onClose={() => setChangePasswordOpen(false)} />}
      {userManagementOpen && <UserManagementPanel workspaces={workspaces} onClose={() => setUserManagementOpen(false)} />}
      {mentionToasts.length > 0 && (
        <div style={styles.mentionToastContainer} role="status" aria-live="polite">
          {mentionToasts.map((t) => (
            <div key={t.id} style={styles.mentionToast}>
              <span style={styles.mentionToastAuthor}>{t.mentionedBy}</span> mentioned you: {t.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
