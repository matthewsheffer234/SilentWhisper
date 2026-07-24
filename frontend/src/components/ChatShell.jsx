import { useCallback, useEffect, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { PresenceProvider, usePresenceUpdater } from '../context/PresenceContext.jsx';
import { createSocket } from '../ws/socket.js';
import * as workspacesApi from '../api/workspaces.js';
import * as organizationsApi from '../api/organizations.js';
import * as notificationsApi from '../api/notifications.js';
import * as directMessagesApi from '../api/directMessages.js';
import * as entitiesApi from '../api/entities.js';
import * as tasksApi from '../api/tasks.js';
import { parseTaskLines } from '../markdown.jsx';
import { PERMISSIONS, hasPermission, hasAnyWorkspaceAdminAccess, hasOrgManagementAccess } from '../authz/permissions.js';
import WorkspaceSidebar from './WorkspaceSidebar.jsx';
import ChannelView from './ChannelView.jsx';
import WorkspaceHome from './WorkspaceHome.jsx';
import WorkspaceDigestPanel from './WorkspaceDigestPanel.jsx';
import ThreadSidebar from './ThreadSidebar.jsx';
import AiSettingsPanel from './AiSettingsPanel.jsx';
import AuditDashboard from './AuditDashboard.jsx';
import AdminAnalyticsPanel from './AdminAnalyticsPanel.jsx';
import ChangePasswordPanel from './ChangePasswordPanel.jsx';
import DisplayNamePanel from './DisplayNamePanel.jsx';
import UserManagementPanel from './UserManagementPanel.jsx';
import BrowseWorkspacesPanel from './BrowseWorkspacesPanel.jsx';
import CreateOrganizationModal from './CreateOrganizationModal.jsx';
import OrgManagementPanel from './OrgManagementPanel.jsx';
import SystemAdminPanel from './SystemAdminPanel.jsx';
import AdminPanel from './AdminPanel.jsx';
import WorkspaceSettingsSheet from './WorkspaceSettingsSheet.jsx';
import NotificationPanel from './NotificationPanel.jsx';
import ChannelDetailsPanel from './ChannelDetailsPanel.jsx';
import EntityDetailsPanel from './EntityDetailsPanel.jsx';
import CreateWorkspaceSheet from './CreateWorkspaceSheet.jsx';
import CreateChannelSheet from './CreateChannelSheet.jsx';
import NewMessageSheet from './NewMessageSheet.jsx';
import { directMessageLabel } from '../directMessages.js';
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
    textAlign: 'left',
    cursor: 'pointer',
  },
  mentionToastAuthor: { fontWeight: 700 },
};

function toDisplayMessage(m) {
  return { ...m, pending: false };
}

// Normalizes a /direct-messages list entry into the same shape channels[]
// entries already have (name/memberCount/isMember), so ChannelView and the
// canAddChannelMembers-style gates below don't need a second code path for
// "is this a DM or a workspace channel."
function toChannelViewShape(dm) {
  return {
    id: dm.id,
    type: dm.type,
    name: directMessageLabel(dm),
    memberCount: dm.members.length + 1,
    isMember: true,
  };
}

// Finding 7, docs/reviews/security-performance-review-2026-07-20.md: a thin
// wrapper providing PresenceContext around the real component below —
// ChatShellInner calls usePresenceUpdater() to feed WS-derived presence
// frames into the context, so it has to render *inside* the provider, not
// wrap it itself.
export default function ChatShell() {
  return (
    <PresenceProvider>
      <ChatShellInner />
    </PresenceProvider>
  );
}

function ChatShellInner() {
  const { user, logout } = useAuth();
  const { mergePresence, setUserPresence } = usePresenceUpdater();

  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [joinedChannels, setJoinedChannels] = useState(() => new Set());
  const [messagesByChannel, setMessagesByChannel] = useState({});
  // Finding 8, docs/reviews/security-performance-review-2026-07-20.md: a
  // `{ "<messageId>:<taskIndex>": checked }` map — presence of a key means
  // that specific checkbox has an optimistic toggle in flight. See
  // markdown.jsx's applyTaskPass for how this overrides the content-derived
  // checked state and disables the row while in flight.
  const [taskOverrides, setTaskOverrides] = useState({});
  const [threadRoot, setThreadRoot] = useState(null);
  const [threadReplies, setThreadReplies] = useState([]);
  // Resolved at the moment a thread is opened (see openThread below), not
  // re-derived from whatever's currently selected — a thread can be opened
  // for a channel other than the one presently selected (search-result and
  // mention navigation both pass an explicit channelIdOverride), so
  // ThreadSidebar needs its own record of which conversation it belongs to.
  const [threadChannelType, setThreadChannelType] = useState(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [adminAnalyticsOpen, setAdminAnalyticsOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [displayNameOpen, setDisplayNameOpen] = useState(false);
  const [channelDetailsOpen, setChannelDetailsOpen] = useState(false);
  const [entityDetails, setEntityDetails] = useState(null); // { workspaceId, entity }
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [directMessages, setDirectMessages] = useState([]);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [userManagementOpen, setUserManagementOpen] = useState(false);
  const [browseWorkspacesOpen, setBrowseWorkspacesOpen] = useState(false);
  const [mentionToasts, setMentionToasts] = useState([]);
  const [membershipInvitationToasts, setMembershipInvitationToasts] = useState([]);
  const [notificationSummary, setNotificationSummary] = useState({ unreadCount: 0 });
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(null);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [orgManagementOpen, setOrgManagementOpen] = useState(false);
  const [systemAdminOpen, setSystemAdminOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  // Cross-channel "Catch Me Up" workspace digest (FEATURE_REQUEST.md entry
  // 6) — opened from WorkspaceHome's "Catch Me Up" button, always scoped to
  // whichever workspace is currently selected.
  const [digestOpen, setDigestOpen] = useState(false);
  // FEATURE_REQUEST.md's "workspace home and actionable empty states" entry:
  // lifted from WorkspaceSidebar.jsx's own local state (where it lived
  // when the sheet was only ever opened from the workspace row's own
  // overflow trigger) so WorkspaceHome's "Invite People" action can open
  // the exact same sheet, not a second, duplicate invite surface.
  const [workspaceSettingsId, setWorkspaceSettingsId] = useState(null);
  // FEATURE_REQUEST.md entry 3: a live projection of task lines across the
  // selected workspace's channels — lifted up here (not owned locally by
  // WorkspaceHome) so the same message_updated WS handler that reconciles
  // messagesByChannel/threadRoot/threadReplies below can also keep this in
  // sync, per that entry's own "one pane can show stale checkbox state
  // while another pane or the dashboard is correct" requirement.
  const [workspaceTasks, setWorkspaceTasks] = useState([]);
  const [workspaceTasksState, setWorkspaceTasksState] = useState({ loading: false, error: null });

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

  // A reply broadcasts to the whole channel room (backend/src/ws/server.js),
  // not just to clients with that thread open — previously that meant
  // anyone without the thread sidebar open simply dropped the event. This
  // keeps the compact reply-count affordance in ChannelView.jsx's already-
  // loaded feed live for everyone in the room, with no extra request and no
  // change to the broadcast payload itself (a fresh message has no replies
  // yet, so newly-created root messages just default to 0 client-side).
  const bumpReplyCount = useCallback((channelId, parentMessageId) => {
    setMessagesByChannel((prev) => {
      const existing = prev[channelId];
      if (!existing) return prev;
      const index = existing.findIndex((m) => m.id === parentMessageId);
      if (index === -1) return prev;
      const next = [...existing];
      next[index] = { ...next[index], replyCount: (next[index].replyCount ?? 0) + 1 };
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

  // FEATURE_REQUEST.md entry 3: the toggle endpoint's own response and the
  // ws `message_updated` broadcast both carry the same full updated-message
  // shape (routes/messages.js) — one reconciliation path handles either
  // trigger. Only ever *replaces* an already-present message in each of the
  // three places it might be displayed; a client that hasn't loaded this
  // message yet has nothing to reconcile; it'll just show the current
  // content next time it's fetched.
  const reconcileUpdatedMessage = useCallback((message) => {
    setMessagesByChannel((prev) => {
      const existing = prev[message.channelId];
      if (!existing) return prev;
      const index = existing.findIndex((m) => m.id === message.id);
      if (index === -1) return prev;
      const next = [...existing];
      next[index] = { ...next[index], ...toDisplayMessage(message) };
      return { ...prev, [message.channelId]: next };
    });
    setThreadRoot((prev) => (prev && prev.id === message.id ? { ...prev, ...message } : prev));
    setThreadReplies((prev) => {
      const index = prev.findIndex((m) => m.id === message.id);
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = { ...next[index], ...toDisplayMessage(message) };
      return next;
    });
  }, []);

  // Re-derives {checked, text, owner} for whichever task rows in the
  // dashboard belong to this message from its fresh content, rather than
  // trusting the caller to say which index/state changed — the same
  // "recompute live, don't trust a second system of record" principle the
  // dashboard endpoint itself already follows server-side. A message with no
  // rows currently in the dashboard's loaded window is left untouched (nil
  // return from `find` below just keeps that row's existing content).
  const reconcileWorkspaceTaskMessage = useCallback((message) => {
    setWorkspaceTasks((prev) => {
      if (!prev.some((t) => t.messageId === message.id)) return prev;
      const freshTasks = parseTaskLines(message.content);
      return prev.map((t) => {
        if (t.messageId !== message.id) return t;
        const fresh = freshTasks.find((f) => f.index === t.taskIndex);
        return fresh ? { ...t, checked: fresh.checked, text: fresh.text, owner: fresh.owner } : t;
      });
    });
  }, []);

  // Socket lifecycle: one connection for the lifetime of the authenticated
  // session (PROJECT_PLAN.md Section 8, Phase 3).
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('authenticated', (frame) => {
      mergePresence(frame.presence);
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
      setUserPresence(frame.userId, frame.status);
    });

    socket.on('message_created', (frame) => {
      if (frame.message.parentMessageId) {
        if (threadRootRef.current && frame.message.parentMessageId === threadRootRef.current.id) {
          reconcileThreadReply(frame);
        }
        bumpReplyCount(frame.message.channelId, frame.message.parentMessageId);
        return;
      }
      reconcileMessage(frame.message.channelId, frame);
    });

    // FEATURE_REQUEST.md entry 3: the only non-create message event today —
    // a task checkbox toggle. Reconciles every pane that might currently be
    // showing this message (main feed, open thread, workspace task
    // dashboard), not just whichever one triggered the toggle.
    socket.on('message_updated', (frame) => {
      reconcileUpdatedMessage(frame.message);
      reconcileWorkspaceTaskMessage(frame.message);
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
      notificationsApi.getNotificationSummary().then(setNotificationSummary).catch(() => {});
      setMentionToasts((prev) => [
        ...prev,
        {
          id: toastId,
          notificationId: frame.notificationId,
          mentionedBy: frame.mentionedByDisplayName || frame.mentionedBy,
          content: frame.message.content,
          channelId: frame.channelId,
          workspaceId: frame.workspaceId,
          messageId: frame.message.id,
          parentMessage: frame.message.parentMessageId ? null : undefined,
        },
      ]);
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
        const notification = new window.Notification(`${frame.mentionedByDisplayName || frame.mentionedBy} mentioned you`, {
          body: frame.message.content,
          icon: mentionIcon,
        });
        notification.onclick = async () => {
          window.focus();
          if (frame.notificationId) {
            await notificationsApi.markMentionNotificationRead(frame.notificationId).catch(() => {});
            notificationsApi.getNotificationSummary().then(setNotificationSummary).catch(() => {});
          }
          handleNavigateToMention({
            notificationId: frame.notificationId,
            channelId: frame.channelId,
            workspaceId: frame.workspaceId,
            parentMessage: null,
          });
        };
      }
    });

    // A membership invitation (FEATURE_REQUEST.md "Live notification
    // system..."): unlike a mention, clicking this toast opens the
    // notification panel directly rather than navigating to a channel —
    // there's no message/thread to jump to, just a pending decision to make.
    socket.on('membership_invitation', (frame) => {
      const toastId = crypto.randomUUID();
      notificationsApi.getNotificationSummary().then(setNotificationSummary).catch(() => {});
      setMembershipInvitationToasts((prev) => [
        ...prev,
        {
          id: toastId,
          inviterDisplayName: frame.inviterDisplayName || frame.inviterUsername,
          scopeName: frame.scopeName,
          invitedRole: frame.invitedRole,
        },
      ]);
      setTimeout(() => {
        setMembershipInvitationToasts((prev) => prev.filter((t) => t.id !== toastId));
      }, 6000);
    });

    socket.on('disconnected', () => setJoinedChannels(new Set()));

    socket.connect();
    return () => socket.disconnect();
  }, [
    reconcileMessage,
    reconcileThreadReply,
    bumpReplyCount,
    reconcileUpdatedMessage,
    reconcileWorkspaceTaskMessage,
    mergePresence,
    setUserPresence,
  ]);

  // Finding 4, docs/reviews/security-performance-review-2026-07-20.md:
  // listWorkspaces/listOrganizations still return every page the caller has
  // (fetchAllPages' existing contract, unchanged), but now call back after
  // each page instead of only once at the very end — so the first workspace/
  // org can be selected, and everything that selection cascades into
  // (channel load, etc.), as soon as the first page lands rather than after
  // every page has. `ws[0]`/`orgs[0]` are stable across pages (new rows are
  // only ever appended), so calling this on every page is a harmless no-op
  // once the first one has already selected something.
  useEffect(() => {
    workspacesApi.listWorkspaces((ws) => {
      setWorkspaces(ws);
      if (ws.length > 0) setSelectedWorkspaceId(ws[0].id);
    });
  }, []);

  useEffect(() => {
    organizationsApi.listOrganizations((orgs) => {
      setOrganizations(orgs);
      if (orgs.length > 0) setSelectedOrganizationId((prev) => prev ?? orgs[0].id);
    });
  }, []);

  useEffect(() => {
    notificationsApi.getNotificationSummary().then(setNotificationSummary).catch(() => {});
  }, []);

  // FEATURE_REQUEST.md entry 3 (Direct Messages navigation): loaded once up
  // front, independent of the currently-selected workspace — DMs are
  // workspace-independent (channels.workspace_id is NULL for DIRECT/
  // GROUP_DM, PROJECT_PLAN.md Section 4), so there's no per-workspace
  // refetch trigger the way channels[] has.
  const refreshDirectMessages = useCallback(() => {
    directMessagesApi.listDirectMessages(setDirectMessages).catch(() => {});
  }, []);

  useEffect(() => {
    refreshDirectMessages();
  }, [refreshDirectMessages]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    // Guards against a pre-existing race this effect's dependency on
    // selectedWorkspaceId always had, now with more opportunities to hit it:
    // onPage fires once per page rather than once at the very end, so a
    // workspace switched away from mid-load must not let its later-arriving
    // pages clobber the newly selected workspace's channels.
    let cancelled = false;
    workspacesApi.listChannels(selectedWorkspaceId, (page) => {
      if (!cancelled) setChannels(page);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  // FEATURE_REQUEST.md entry 3. WorkspaceHome only ever renders once no
  // channel is selected, so this refetches on every transition *into* that
  // view — both a fresh workspace switch and clicking back to Home from a
  // channel within the same workspace (handleSelectWorkspace's own
  // re-clicking-the-active-workspace-clears-selectedChannelId path, the
  // most common way to reach Home at all). A fetch keyed only on
  // selectedWorkspaceId (the first version of this effect) missed that
  // second case entirely: switching workspaces once loaded a stale
  // snapshot, and returning to Home later without a workspace change never
  // refreshed it — stale data was invisible until a hard reload remounted
  // everything. The dashboard query is already bounded/paginated
  // server-side, so refetching on every arrival at Home costs nothing extra.
  const refreshWorkspaceTasks = useCallback((workspaceId) => {
    if (!workspaceId) {
      setWorkspaceTasks([]);
      setWorkspaceTasksState({ loading: false, error: null });
      return;
    }
    setWorkspaceTasksState({ loading: true, error: null });
    tasksApi
      .getWorkspaceTasks(workspaceId)
      .then((res) => {
        setWorkspaceTasks(res.tasks);
        setWorkspaceTasksState({ loading: false, error: null });
      })
      .catch((err) => {
        setWorkspaceTasks([]);
        setWorkspaceTasksState({ loading: false, error: err.message || 'Failed to load tasks' });
      });
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId || selectedChannelId) return;
    refreshWorkspaceTasks(selectedWorkspaceId);
  }, [selectedWorkspaceId, selectedChannelId, refreshWorkspaceTasks]);

  // FEATURE_REQUEST.md's "workspace home and actionable empty states" entry
  // surfaced a real, pre-existing gap: WorkspaceSidebar.jsx's own org
  // switcher has always filtered its *visible* workspace list client-side
  // by `selectedOrganizationId`, but nothing ever cleared the *selected*
  // workspace when it fell outside that filter — invisible before this
  // entry, since the old "Select a channel to get started." fallback
  // carried no workspace-specific data to look stale. Now that the main
  // pane renders an actual WorkspaceHome for whatever `selectedWorkspaceId`
  // still points at, an orphaned selection would keep showing a workspace
  // the sidebar itself no longer lists as belonging to the current org.
  // Deliberately clears rather than auto-picking a replacement — the org
  // switch already happened by the time this runs, so there's no single
  // "right" workspace to fall back to, and clearing matches this app's
  // existing "no workspace selected" state exactly.
  useEffect(() => {
    if (!selectedOrganizationId || !selectedWorkspaceId) return;
    const current = workspaces.find((ws) => ws.id === selectedWorkspaceId);
    if (current && current.organizationId && current.organizationId !== selectedOrganizationId) {
      setSelectedWorkspaceId(null);
      setSelectedChannelId(null);
    }
  }, [selectedOrganizationId, selectedWorkspaceId, workspaces]);

  // A channel details panel belongs to the channel it was opened for —
  // close it out on switch rather than leaving stale member data visible
  // under a different channel's header (same reasoning ChannelView's own
  // effect already applies to its Summarize panel).
  useEffect(() => {
    setChannelDetailsOpen(false);
  }, [selectedChannelId]);

  useEffect(() => {
    setEntityDetails(null);
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

  // Clicking a workspace that's already selected returns to its home screen
  // instead of being a no-op — otherwise there was no way back to
  // WorkspaceHome once a channel was open, short of switching to a
  // different workspace and back (which doesn't actually clear the old
  // channel selection either). Same "re-clicking the active section goes
  // home" pattern the org switcher already relies on implicitly.
  const handleSelectWorkspace = useCallback(
    (workspaceId) => {
      if (workspaceId === selectedWorkspaceId) {
        setSelectedChannelId(null);
        setThreadRoot(null);
      }
      setSelectedWorkspaceId(workspaceId);
    },
    [selectedWorkspaceId],
  );

  // FEATURE_REQUEST.md's "focused creation sheets" entry: organizationId is
  // now an explicit field in CreateWorkspaceSheet itself (only shown when
  // the caller belongs to more than one org), superseding the older
  // slice-3 comment this replaced ("no second, redundant org control" — true
  // when this was the only org-aware surface around, no longer true once the
  // sheet has its own explicit picker). Falls back to the sidebar's
  // currently-selected org when the sheet didn't show one (the single-org
  // case, where there's nothing to pick).
  async function handleCreateWorkspace(name, visibility, organizationId) {
    const ws = await workspacesApi.createWorkspace(name, visibility, organizationId ?? selectedOrganizationId);
    setWorkspaces((prev) => [...prev, ws]);
    setSelectedWorkspaceId(ws.id);
  }

  async function handleCreateOrganization(name) {
    const org = await organizationsApi.createOrganization(name);
    setOrganizations((prev) => [...prev, org]);
    setSelectedOrganizationId(org.id);
    setCreateOrgOpen(false);
  }

  // FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"), Part 3.
  async function handleLeaveOrganization(orgId) {
    await organizationsApi.leaveOrganization(orgId);
    const remaining = organizations.filter((org) => org.id !== orgId);
    setOrganizations(remaining);
    setSelectedOrganizationId((current) => (current === orgId ? (remaining[0]?.id ?? null) : current));
  }

  function handleSubscribed(ws) {
    setWorkspaces((prev) => [...prev, ws]);
    setSelectedWorkspaceId(ws.id);
  }

  // FEATURE_REQUEST.md's "focused creation sheets" entry: optional initial
  // invitees for a private channel, added sequentially after creation via
  // the existing add-member endpoint — no schema/API change needed for
  // this, per the design's own "keep existing create endpoints" note.
  async function handleCreateChannel(name, type, initialInviteeUsernames = []) {
    const ch = await workspacesApi.createChannel(selectedWorkspaceId, name, type);
    setChannels((prev) => [...prev, { ...ch, isMember: true, memberCount: 1 }]);
    selectChannel(ch.id);
    for (const username of initialInviteeUsernames) {
      // eslint-disable-next-line no-await-in-loop
      await workspacesApi.addChannelMember(selectedWorkspaceId, ch.id, username).catch(() => {});
    }
  }

  // FEATURE_REQUEST.md entry 3: "One selected person creates/opens a direct
  // DM; multiple selected people create a group DM." POST /direct-messages
  // itself is idempotent (reopens the existing DIRECT channel rather than
  // creating a duplicate) — group DMs have no such reuse concept (every
  // create is a new channel, matching POST /group-direct-messages's own
  // behavior), so only the single-person path can ever resolve to a channel
  // already in `directMessages`.
  async function handleCreateDirectMessage(memberIds) {
    const result =
      memberIds.length === 1
        ? await directMessagesApi.createDirectMessage(memberIds[0])
        : await directMessagesApi.createGroupDirectMessage(memberIds);
    refreshDirectMessages();
    selectChannel(result.id);
  }

  function handleInviteMember(workspaceId, username, role) {
    return workspacesApi.inviteWorkspaceMember(workspaceId, username, role);
  }

  function handleInviteMembership(workspaceId, userId, role) {
    return workspacesApi.createWorkspaceMembershipInvitation(workspaceId, userId, role);
  }

  function handleCreateInviteLink(workspaceId, role) {
    return workspacesApi.createWorkspaceInvitation(workspaceId, role);
  }

  async function handleArchiveWorkspace(workspaceId) {
    const { archivedAt } = await workspacesApi.archiveWorkspace(workspaceId);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, archivedAt } : ws)));
  }

  async function handleUnarchiveWorkspace(workspaceId) {
    await workspacesApi.unarchiveWorkspace(workspaceId);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, archivedAt: null } : ws)));
  }

  // Transfer flips two members' roles (the caller's own row included) —
  // simplest to just refetch rather than hand-rolling a local patch that
  // also has to update the caller's own role in the list.
  async function handleTransferOwnership(workspaceId, username) {
    await workspacesApi.transferWorkspaceOwnership(workspaceId, username);
    const ws = await workspacesApi.listWorkspaces();
    setWorkspaces(ws);
  }

  async function handleChangeVisibility(workspaceId, visibility) {
    await workspacesApi.changeWorkspaceVisibility(workspaceId, visibility);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, visibility } : ws)));
  }

  async function handleToggleManagersCanArchive(workspaceId, managersCanArchive) {
    await workspacesApi.updateWorkspaceSettings(workspaceId, { managersCanArchive });
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, managersCanArchive } : ws)));
  }

  // FEATURE_REQUEST.md entry 1 (2026-07-23, "Admin workflow gap-closing"), Part 2.
  async function handleRenameWorkspace(workspaceId, name) {
    await workspacesApi.renameWorkspace(workspaceId, name);
    setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? { ...ws, name } : ws)));
  }

  // Part 3 — self-removal, same "no longer in the caller's own list at all"
  // outcome handleArchiveWorkspace's own comment doesn't need (archiving
  // keeps the workspace visible; leaving doesn't).
  async function handleLeaveWorkspace(workspaceId) {
    await workspacesApi.leaveWorkspace(workspaceId);
    const remaining = workspaces.filter((ws) => ws.id !== workspaceId);
    setWorkspaces(remaining);
    if (selectedWorkspaceId === workspaceId) {
      setSelectedChannelId(null);
      setThreadRoot(null);
      setSelectedWorkspaceId(remaining[0]?.id ?? null);
    }
  }

  async function handleJoinChannel(channelId) {
    await workspacesApi.joinChannel(selectedWorkspaceId, channelId);
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, isMember: true } : c)));
    selectChannel(channelId);
  }

  function handleInviteToChannel(channelId, username) {
    return workspacesApi.addChannelMember(selectedWorkspaceId, channelId, username);
  }

  // Part 4 — addChannelMember's delete counterpart.
  function handleRemoveChannelMember(channelId, userId) {
    return workspacesApi.removeChannelMember(selectedWorkspaceId, channelId, userId);
  }

  // Part 2.
  async function handleRenameChannel(channelId, name) {
    await workspacesApi.renameChannel(selectedWorkspaceId, channelId, name);
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, name } : c)));
  }

  // Part 3 — a PRIVATE channel disappears from the list entirely once the
  // caller isn't a member anymore (matching GET /:workspaceId/channels'
  // own visibility rule); a PUBLIC channel stays listed, just isMember: false,
  // same as it would for anyone who's never joined it.
  async function handleLeaveChannel(channelId) {
    await workspacesApi.leaveChannel(selectedWorkspaceId, channelId);
    setChannels((prev) =>
      prev.reduce((acc, c) => {
        if (c.id !== channelId) {
          acc.push(c);
        } else if (c.type !== 'PRIVATE') {
          acc.push({ ...c, isMember: false, memberCount: Math.max(0, (c.memberCount ?? 1) - 1) });
        }
        return acc;
      }, []),
    );
    setChannelDetailsOpen(false);
    if (selectedChannelId === channelId) {
      setSelectedChannelId(null);
      setThreadRoot(null);
    }
  }

  // FEATURE_REQUEST.md entry 3. Threaded into both ChannelView and
  // ThreadSidebar as `onToggleTask` — always the currently selected
  // channel, matching handleSendReply's own existing assumption that a
  // thread open at all means its origin channel is the selected one
  // (handleNavigateToSearchResult/handleNavigateToMention both call
  // selectChannel before openThread for exactly this reason). Reconciles
  // immediately from this call's own response rather than waiting on the
  // WS echo, the same "don't wait for your own broadcast" shape
  // reconcileMessage's create-path already gets via the POST response.
  //
  // Finding 8, docs/reviews/security-performance-review-2026-07-20.md: the
  // checked state used to only update once the round trip resolved, with no
  // feedback in between and nothing stopping a second click from racing the
  // first. Now applies the same optimistic-first convention handleSend's
  // `pending: true` messages already establish: flip taskOverrides for this
  // exact (messageId, taskIndex) immediately, so the checkbox both shows the
  // new state and disables itself for the duration of its own request; the
  // `finally` clears the override whether the request succeeds (the
  // reconcile above already applied the authoritative content by then) or
  // fails (clearing the override reverts the row to whatever the last-known
  // real content says, i.e. a rollback, matching the toggle endpoint's own
  // explicit-target-state semantics — nothing to reconcile away from).
  // Finding 7, docs/reviews/security-performance-review-2026-07-20.md: this
  // and the handful of handlers below it are wrapped in useCallback (rather
  // than the plain function declarations most of this file still uses) so
  // their reference stays stable across a ChatShellInner re-render caused
  // by something unrelated (e.g. a sheet opening elsewhere) — required for
  // React.memo(ChannelView)/React.memo(ThreadSidebar)/the per-row
  // React.memo(MessageRow) in ChannelView.jsx to actually skip re-rendering
  // instead of just wrapping components that still get fresh prop
  // references every render regardless.
  const handleToggleTask = useCallback(
    async (messageId, taskIndex, checked) => {
      const overrideKey = `${messageId}:${taskIndex}`;
      setTaskOverrides((prev) => ({ ...prev, [overrideKey]: checked }));
      try {
        const updated = await tasksApi.toggleTask(selectedChannelId, messageId, taskIndex, checked);
        reconcileUpdatedMessage(updated);
        reconcileWorkspaceTaskMessage(updated);
      } catch {
        // A stale taskIndex (e.g. raced against another toggle) fails
        // silently client-side — there's no dedicated error UI for this
        // lightweight action; clearing the override below rolls the
        // checkbox back to whatever the real content still says.
      } finally {
        setTaskOverrides((prev) => {
          const next = { ...prev };
          delete next[overrideKey];
          return next;
        });
      }
    },
    [selectedChannelId, reconcileUpdatedMessage, reconcileWorkspaceTaskMessage],
  );

  // The dashboard-originated equivalent: a task row already carries its own
  // channelId (routes/tasks.js's response shape), unlike ChannelView/
  // ThreadSidebar, which always operate on whatever's currently selected.
  // Same optimistic-override shape as handleToggleTask above — one shared
  // taskOverrides map, since the two surfaces can show the same task
  // simultaneously (dashboard + open channel) and both must reflect the
  // same in-flight state.
  const handleToggleDashboardTask = useCallback(
    async (channelId, messageId, taskIndex, checked) => {
      const overrideKey = `${messageId}:${taskIndex}`;
      setTaskOverrides((prev) => ({ ...prev, [overrideKey]: checked }));
      try {
        const updated = await tasksApi.toggleTask(channelId, messageId, taskIndex, checked);
        reconcileUpdatedMessage(updated);
        reconcileWorkspaceTaskMessage(updated);
      } catch {
        // Same silent-failure/rollback reasoning as handleToggleTask above.
      } finally {
        setTaskOverrides((prev) => {
          const next = { ...prev };
          delete next[overrideKey];
          return next;
        });
      }
    },
    [reconcileUpdatedMessage, reconcileWorkspaceTaskMessage],
  );

  const handleSend = useCallback(
    (content) => {
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
    },
    [selectedChannelId, user.id, user.username],
  );

  const openThread = useCallback(
    (rootMessage, channelIdOverride = selectedChannelId) => {
      setThreadRoot(rootMessage);
      const originChannel =
        channels.find((c) => c.id === channelIdOverride) ?? directMessages.find((dm) => dm.id === channelIdOverride);
      setThreadChannelType(originChannel?.type ?? null);
      workspacesApi.listMessages(channelIdOverride, { parentMessageId: rootMessage.id }).then((history) => {
        setThreadReplies([...history].reverse().map(toDisplayMessage));
      });
    },
    [selectedChannelId, channels, directMessages],
  );

  const handleSendReply = useCallback(
    (content) => {
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
    },
    [selectedChannelId, user.id, user.username, threadRoot],
  );

  const handleCloseThread = useCallback(() => setThreadRoot(null), []);
  const handleOpenChannelDetails = useCallback(() => setChannelDetailsOpen(true), []);

  // FEATURE_REQUEST.md entry 1 (semantic search): the search route already
  // includes the thread root (parentMessage) on a reply hit, so opening the
  // thread here needs no extra fetch — openThread only ever reads
  // rootMessage.id/username/content. workspaceId is left untouched when a
  // hit has none (DM/group-DM channels, workspace_id nullable per schema) —
  // selectChannel still works and (entry 3) now correctly highlights the
  // matching row in the sidebar's own Direct Messages section, since
  // selectedChannel resolves against directMessages[] as well as channels[]
  // below. Called from SearchBar (the HIG overhaul entry's persistent search
  // field), which closes/resets its own popover state itself on navigate —
  // this function only owns cross-component navigation, not that
  // component's local UI state.
  function handleNavigateToSearchResult(hit) {
    if (hit.workspaceId && hit.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(hit.workspaceId);
    }
    selectChannel(hit.channelId);
    if (hit.parentMessage) {
      openThread(hit.parentMessage, hit.channelId);
    }
  }

  async function handleNavigateToMention(notification) {
    if (notification.workspaceId && notification.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(notification.workspaceId);
    }
    selectChannel(notification.channelId);
    if (notification.parentMessage) {
      openThread(notification.parentMessage, notification.channelId);
    }
    if (notification.notificationId || notification.id) {
      await notificationsApi.markMentionNotificationRead(notification.notificationId || notification.id).catch(() => {});
      notificationsApi.getNotificationSummary().then(setNotificationSummary).catch(() => {});
    }
  }

  const handleOpenEntity = useCallback(
    async (label) => {
      if (!selectedWorkspaceId) return;
      try {
        const entity = await entitiesApi.resolveEntity(selectedWorkspaceId, label);
        setEntityDetails({ workspaceId: selectedWorkspaceId, entity });
      } catch {
        // Entity text can be stale or unresolved if a message was typed
        // before the registry feature existed. A failed resolve should not
        // disturb the reader or break message rendering.
      }
    },
    [selectedWorkspaceId],
  );

  // FEATURE_REQUEST.md entry 3 (Direct Messages navigation): a DM/group-DM
  // isn't in channels[] (that list is fetched per-workspace) — falls back to
  // directMessages[] so selecting one still resolves to a real channel
  // object for ChannelView, without requiring a workspace to be selected at
  // all (design: "should not require a workspace highlight").
  const selectedDirectMessage = directMessages.find((d) => d.id === selectedChannelId) ?? null;
  const selectedChannel =
    channels.find((c) => c.id === selectedChannelId) ??
    (selectedDirectMessage ? toChannelViewShape(selectedDirectMessage) : null);
  // Workspace-scoped admin access (Admin hub's "Manage Users" row only) —
  // is_system_admin OR OWNER/MANAGER in at least one workspace. AI Settings
  // and Audit Log are separate, global surfaces gated directly on
  // isSystemAdmin below (Security.md, 2026-07-15, HIGH finding: they used
  // to share this same OR-fallback, letting self-service workspace
  // ownership grant access to global surfaces too — see AdminPanel.jsx and
  // requireSystemAdmin's backend doc comment).
  const canManageWorkspaceUsers = hasAnyWorkspaceAdminAccess(user?.isSystemAdmin, workspaces);
  // FEATURE_REQUEST.md's "dedicated admin/settings area" entry: the Admin
  // hub's "Manage Organization" row is worth showing if the caller manages
  // *any* organization, not just the currently-selected one (OrgManagementPanel
  // itself already has its own manageable-org selector once opened).
  const canManageOrg = organizations.some((org) => hasOrgManagementAccess(user?.isSystemAdmin, org.role));
  const isSelectedWorkspaceArchived = Boolean(workspaces.find((ws) => ws.id === selectedWorkspaceId)?.archivedAt);
  // A DM/group-DM has no workspace of its own to be archived — never
  // read-only on account of whatever workspace happens to still be
  // selected in the background.
  const isSelectedChannelArchived = isSelectedWorkspaceArchived && !selectedDirectMessage;
  const selectedWorkspaceName = workspaces.find((ws) => ws.id === selectedWorkspaceId)?.name ?? null;
  // Same gate ChannelDetailsPanel's "Add people" section uses
  // (FEATURE_REQUEST.md's private-channel invite workflow entry) — any
  // member of a PRIVATE channel can add someone else to it, no extra
  // permission beyond membership.
  const canAddChannelMembers = Boolean(
    selectedChannel?.isMember && selectedChannel?.type === 'PRIVATE' && !isSelectedChannelArchived,
  );
  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? null;
  // FEATURE_REQUEST.md's "workspace home and actionable empty states" entry:
  // WorkspaceHome's own "Invite People" action reuses this same gate
  // WorkspaceSidebar's overflow menu already computes per-row.
  const canInviteToSelectedWorkspace = Boolean(
    selectedWorkspace && hasPermission(selectedWorkspace.role, PERMISSIONS.WORKSPACE_MANAGE_MEMBERS),
  );
  const workspaceSettingsTarget = workspaces.find((ws) => ws.id === workspaceSettingsId) ?? null;

  return (
    <div style={styles.shell}>
      <WorkspaceSidebar
        user={user}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        channels={channels}
        selectedChannelId={selectedChannelId}
        onSelectChannel={selectChannel}
        onJoinChannel={handleJoinChannel}
        onLogout={logout}
        canManageWorkspaceUsers={canManageWorkspaceUsers}
        onNavigateToSearchResult={handleNavigateToSearchResult}
        onOpenChangePassword={() => setChangePasswordOpen(true)}
        onOpenDisplayName={() => setDisplayNameOpen(true)}
        onUnarchiveWorkspace={handleUnarchiveWorkspace}
        onOpenBrowseWorkspaces={() => setBrowseWorkspacesOpen(true)}
        organizations={organizations}
        selectedOrganizationId={selectedOrganizationId}
        onSelectOrganization={setSelectedOrganizationId}
        isSystemAdmin={Boolean(user?.isSystemAdmin)}
        onOpenCreateOrganization={() => setCreateOrgOpen(true)}
        onOpenAdminPanel={() => setAdminPanelOpen(true)}
        onOpenWorkspaceSettings={setWorkspaceSettingsId}
        onOpenDigest={() => setDigestOpen(true)}
        notificationSummary={notificationSummary}
        onOpenNotifications={() => setNotificationsOpen(true)}
        onOpenCreateWorkspace={() => setCreateWorkspaceOpen(true)}
        onOpenCreateChannel={() => setCreateChannelOpen(true)}
        directMessages={directMessages}
        onOpenNewMessage={() => setNewMessageOpen(true)}
        onLeaveOrganization={handleLeaveOrganization}
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
      {selectedWorkspace && !selectedChannel ? (
        // FEATURE_REQUEST.md's "workspace home and actionable empty states"
        // entry: a workspace selected with no channel open gets an actual
        // overview instead of ChannelView's generic "Select a channel to
        // get started." fallback (still used below for the rarer case of
        // no workspace existing/selected at all).
        <WorkspaceHome
          mainContentId="main"
          workspace={selectedWorkspace}
          channels={channels}
          archived={isSelectedWorkspaceArchived}
          canInvite={canInviteToSelectedWorkspace}
          onSelectChannel={selectChannel}
          onJoinChannel={handleJoinChannel}
          onCreateChannel={() => setCreateChannelOpen(true)}
          onOpenWorkspaceSettings={() => setWorkspaceSettingsId(selectedWorkspace.id)}
          currentUser={user}
          tasks={workspaceTasks}
          tasksLoading={workspaceTasksState.loading}
          tasksError={workspaceTasksState.error}
          onToggleDashboardTask={handleToggleDashboardTask}
          taskOverrides={taskOverrides}
        />
      ) : (
        <ChannelView
          mainContentId="main"
          channel={selectedChannel}
          messages={messagesByChannel[selectedChannelId] ?? []}
          currentUser={user}
          joined={joinedChannels.has(selectedChannelId)}
          archived={isSelectedChannelArchived}
          onSend={handleSend}
          onOpenThread={openThread}
          onToggleTask={handleToggleTask}
          taskOverrides={taskOverrides}
          onOpenDetails={handleOpenChannelDetails}
          workspaceId={selectedDirectMessage ? null : selectedWorkspaceId}
          onOpenEntity={selectedDirectMessage ? undefined : handleOpenEntity}
        />
      )}
      <ThreadSidebar
        rootMessage={threadRoot}
        replies={threadReplies}
        currentUser={user}
        onSendReply={handleSendReply}
        onClose={handleCloseThread}
        isDirectConversation={threadChannelType === 'DIRECT' || threadChannelType === 'GROUP_DM'}
        onOpenEntity={threadChannelType === 'DIRECT' || threadChannelType === 'GROUP_DM' ? undefined : handleOpenEntity}
        onToggleTask={handleToggleTask}
        taskOverrides={taskOverrides}
      />
      {createWorkspaceOpen && (
        <CreateWorkspaceSheet
          organizations={organizations}
          selectedOrganizationId={selectedOrganizationId}
          onCreate={handleCreateWorkspace}
          onClose={() => setCreateWorkspaceOpen(false)}
        />
      )}
      {createChannelOpen && (
        <CreateChannelSheet
          workspaceId={selectedWorkspaceId}
          onCreate={handleCreateChannel}
          onClose={() => setCreateChannelOpen(false)}
        />
      )}
      {newMessageOpen && (
        <NewMessageSheet
          organizationId={selectedOrganizationId}
          onCreate={handleCreateDirectMessage}
          onClose={() => setNewMessageOpen(false)}
        />
      )}
      {channelDetailsOpen && selectedChannel && (
        <ChannelDetailsPanel
          channel={selectedChannel}
          workspaceId={selectedWorkspaceId}
          workspaceName={selectedWorkspaceName}
          canAddMembers={canAddChannelMembers}
          archived={isSelectedWorkspaceArchived}
          onAddMember={handleInviteToChannel}
          onRemoveMember={handleRemoveChannelMember}
          onRename={handleRenameChannel}
          onLeave={handleLeaveChannel}
          onClose={() => setChannelDetailsOpen(false)}
        />
      )}
      {entityDetails && (
        <EntityDetailsPanel
          workspaceId={entityDetails.workspaceId}
          entityId={entityDetails.entity.id}
          initialEntity={entityDetails.entity}
          onClose={() => setEntityDetails(null)}
        />
      )}
      {aiSettingsOpen && <AiSettingsPanel onClose={() => setAiSettingsOpen(false)} />}
      {auditLogOpen && <AuditDashboard onClose={() => setAuditLogOpen(false)} />}
      {adminAnalyticsOpen && <AdminAnalyticsPanel onClose={() => setAdminAnalyticsOpen(false)} />}
      {changePasswordOpen && <ChangePasswordPanel onClose={() => setChangePasswordOpen(false)} />}
      {displayNameOpen && <DisplayNamePanel onClose={() => setDisplayNameOpen(false)} />}
      {userManagementOpen && (
        <UserManagementPanel
          workspaces={workspaces}
          isSystemAdmin={Boolean(user?.isSystemAdmin)}
          onClose={() => setUserManagementOpen(false)}
        />
      )}
      {browseWorkspacesOpen && (
        <BrowseWorkspacesPanel
          onClose={() => setBrowseWorkspacesOpen(false)}
          onSubscribed={handleSubscribed}
          organizationId={selectedOrganizationId}
        />
      )}
      {digestOpen && selectedWorkspace && (
        <WorkspaceDigestPanel workspace={selectedWorkspace} channels={channels} onClose={() => setDigestOpen(false)} />
      )}
      {createOrgOpen && (
        <CreateOrganizationModal onClose={() => setCreateOrgOpen(false)} onCreate={handleCreateOrganization} />
      )}
      {orgManagementOpen && (
        <OrgManagementPanel
          organizations={organizations}
          initialOrgId={selectedOrganizationId}
          isSystemAdmin={Boolean(user?.isSystemAdmin)}
          onClose={() => setOrgManagementOpen(false)}
        />
      )}
      {systemAdminOpen && <SystemAdminPanel onClose={() => setSystemAdminOpen(false)} />}
      {adminPanelOpen && (
        <AdminPanel
          onClose={() => setAdminPanelOpen(false)}
          canManageWorkspaceUsers={canManageWorkspaceUsers}
          canManageOrg={canManageOrg}
          isSystemAdmin={Boolean(user?.isSystemAdmin)}
          onOpenUserManagement={() => setUserManagementOpen(true)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onOpenAuditLog={() => setAuditLogOpen(true)}
          onOpenOrgManagement={() => setOrgManagementOpen(true)}
          onOpenSystemAdmin={() => setSystemAdminOpen(true)}
          onOpenAdminAnalytics={() => setAdminAnalyticsOpen(true)}
        />
      )}
      {workspaceSettingsTarget && (
        <WorkspaceSettingsSheet
          workspace={workspaceSettingsTarget}
          onClose={() => setWorkspaceSettingsId(null)}
          onInviteMember={(username, role) => handleInviteMember(workspaceSettingsTarget.id, username, role)}
          onInviteMembership={(userId, role) => handleInviteMembership(workspaceSettingsTarget.id, userId, role)}
          onCreateInviteLink={(role) => handleCreateInviteLink(workspaceSettingsTarget.id, role)}
          onTransferOwnership={(username) => handleTransferOwnership(workspaceSettingsTarget.id, username)}
          onChangeVisibility={(visibility) => handleChangeVisibility(workspaceSettingsTarget.id, visibility)}
          onToggleManagersCanArchive={(value) => handleToggleManagersCanArchive(workspaceSettingsTarget.id, value)}
          onRenameWorkspace={(name) => handleRenameWorkspace(workspaceSettingsTarget.id, name)}
          onArchiveWorkspace={() => handleArchiveWorkspace(workspaceSettingsTarget.id)}
          onLeaveWorkspace={() => handleLeaveWorkspace(workspaceSettingsTarget.id)}
        />
      )}
      {notificationsOpen && (
        <NotificationPanel
          onClose={() => setNotificationsOpen(false)}
          onNavigate={handleNavigateToMention}
          onSummaryChange={setNotificationSummary}
        />
      )}
      {mentionToasts.length > 0 && (
        <div style={styles.mentionToastContainer} role="status" aria-live="polite">
          {mentionToasts.map((t) => (
            <button key={t.id} type="button" style={styles.mentionToast} onClick={() => handleNavigateToMention(t)}>
              <span style={styles.mentionToastAuthor}>{t.mentionedBy}</span> mentioned you: {t.content}
            </button>
          ))}
        </div>
      )}
      {membershipInvitationToasts.length > 0 && (
        <div style={styles.mentionToastContainer} role="status" aria-live="polite">
          {membershipInvitationToasts.map((t) => (
            <button
              key={t.id}
              type="button"
              style={styles.mentionToast}
              onClick={() => {
                setMembershipInvitationToasts((prev) => prev.filter((toast) => toast.id !== t.id));
                setNotificationsOpen(true);
              }}
            >
              <UserPlus size={14} aria-hidden="true" />{' '}
              <span style={styles.mentionToastAuthor}>{t.inviterDisplayName}</span> invited you to {t.scopeName} as{' '}
              {t.invitedRole}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
