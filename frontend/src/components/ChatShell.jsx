import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { createSocket } from '../ws/socket.js';
import * as workspacesApi from '../api/workspaces.js';
import WorkspaceSidebar from './WorkspaceSidebar.jsx';
import ChannelView from './ChannelView.jsx';
import ThreadSidebar from './ThreadSidebar.jsx';
import AiSettingsPanel from './AiSettingsPanel.jsx';

const styles = {
  shell: { display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' },
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

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;
  // The AI settings surface is admin-only (PROJECT_PLAN.md Section 6); the
  // backend gates it on "ADMIN in at least one workspace" (Section 8, Phase
  // 4 — see requireAnyWorkspaceAdmin's doc comment), so the entry point
  // mirrors that same rule rather than the currently-selected workspace's
  // role.
  const canManageAi = workspaces.some((ws) => ws.role === 'ADMIN');

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
      />
      <ChannelView
        channel={selectedChannel}
        messages={messagesByChannel[selectedChannelId] ?? []}
        presence={presence}
        currentUser={user}
        joined={joinedChannels.has(selectedChannelId)}
        onSend={handleSend}
        onOpenThread={openThread}
      />
      <ThreadSidebar
        rootMessage={threadRoot}
        replies={threadReplies}
        presence={presence}
        onSendReply={handleSendReply}
        onClose={() => setThreadRoot(null)}
      />
      {aiSettingsOpen && <AiSettingsPanel onClose={() => setAiSettingsOpen(false)} />}
    </div>
  );
}
