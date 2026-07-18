import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { db } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { requireChannelMember, requireWorkspaceNotArchived } from '../authz/membershipService.js';
import { createMessage } from '../services/messageService.js';
import { enqueueMessageSideEffectJobs } from '../services/messageSideEffectsQueue.js';
import { enqueueEmbeddingJob } from '../search/embeddingQueue.js';
import {
  registerConnection,
  unregisterConnection,
  getConnectionCount,
  joinRoom,
  leaveRoom,
  leaveAllRooms,
  broadcastToRoom,
} from './connectionRegistry.js';
import { recordHeartbeat, handleDisconnect, getAllStatuses } from './presence.js';
import { isMessageRateLimited } from './rateLimiter.js';

function send(ws, event) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function sendError(ws, error, context) {
  send(ws, { type: 'error', error, context });
}

// PROJECT_PLAN.md Section 3, WebSocket Authentication Handshake: the socket
// opens unauthenticated — no room joins, no data — until an `authenticate`
// frame validates. Everything else in this file assumes that invariant.
export function attachWebSocketServer(httpServer) {
  // maxPayload (FEATURE_REQUEST.md entry 1): `ws` rejects and closes any
  // frame larger than this before it's buffered or handed to our 'message'
  // handler for JSON.parse — closing an unauthenticated memory/CPU
  // exhaustion vector rather than relying on validation that only runs
  // after the oversized frame is already fully received.
  const wss = new WebSocketServer({
    server: httpServer,
    path: config.ws.path,
    maxPayload: config.ws.maxPayloadBytes,
  });

  wss.on('connection', (ws) => {
    ws.authenticated = false;
    ws.userId = null;
    ws.username = null;
    ws.displayName = null;
    ws.tokenExp = null;
    ws.joinedChannels = new Set();

    // Required as soon as `maxPayload` is set (FEATURE_REQUEST.md entry 1):
    // an oversized frame surfaces as an 'error' event on this socket (`ws`'s
    // receiver rejects it before 'message' ever fires), and an EventEmitter
    // 'error' event with no listener is a fatal, process-crashing exception
    // in Node — not just a dropped event. `ws` already closes the
    // connection itself (code 1009) once it emits this, so there's nothing
    // left to do here beyond preventing the crash.
    ws.on('error', () => {});

    ws.on('message', async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'Malformed frame');
        return;
      }
      if (!frame || typeof frame.type !== 'string') {
        sendError(ws, 'Malformed frame');
        return;
      }

      if (frame.type === 'authenticate') {
        await handleAuthenticate(ws, frame);
        return;
      }

      if (!ws.authenticated) {
        sendError(ws, 'Not authenticated');
        ws.close(4001, 'Not authenticated');
        return;
      }

      switch (frame.type) {
        case 'join':
          await handleJoin(ws, frame);
          break;
        case 'leave':
          handleLeave(ws, frame);
          break;
        case 'message':
          await handleMessage(ws, frame);
          break;
        case 'heartbeat':
          recordHeartbeat(ws.userId);
          send(ws, { type: 'heartbeat_ack' });
          break;
        default:
          sendError(ws, `Unknown frame type: ${frame.type}`);
      }
    });

    ws.on('close', () => {
      if (ws.authenticated) {
        leaveAllRooms(ws);
        unregisterConnection(ws.userId, ws);
        handleDisconnect(ws.userId);
      }
    });
  });

  // Enforces the access-token TTL against already-open sockets — without
  // this, a long-lived WebSocket session would keep trusting a credential
  // that would have expired on any REST call (Section 3, "Long-lived
  // connections outlive the access token").
  const sweepInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.authenticated && client.tokenExp && Date.now() >= client.tokenExp * 1000) {
        sendError(client, 'Access token expired; reconnect required');
        client.close(4002, 'Token expired');
      }
    }
  }, config.ws.tokenExpirySweepIntervalMs);
  sweepInterval.unref?.();
  wss.on('close', () => clearInterval(sweepInterval));

  return wss;
}

async function handleAuthenticate(ws, frame) {
  let claims;
  try {
    claims = verifyAccessToken(frame.accessToken);
  } catch {
    sendError(ws, 'Invalid or expired access token', 'authenticate');
    ws.close(4001, 'Invalid token');
    return;
  }

  // Mirrors requireAuth's identical status re-check (FEATURE_REQUEST.md
  // entry 1) — the JWT alone doesn't reflect a status change made after it
  // was issued. Runs on every authenticate frame, including a reconnect and
  // an in-place re-auth on an already-open socket, not just the first one:
  // a disabled user must not be able to re-establish or renew a session
  // with a still-unexpired token. Same generic message as an invalid token
  // so a disabled account can't be distinguished from an expired one.
  const user = await db('users').where({ id: claims.userId }).first('status');
  if (!user || user.status !== 'ACTIVE') {
    sendError(ws, 'Invalid or expired access token', 'authenticate');
    ws.close(4001, 'Invalid token');
    return;
  }

  if (ws.authenticated && ws.userId !== claims.userId) {
    // A socket re-authenticating as a *different* user is not a supported
    // token-renewal case — treat it the same as any other invalid handshake.
    sendError(ws, 'Cannot change identity on an existing connection', 'authenticate');
    ws.close(4001, 'Identity mismatch');
    return;
  }

  const isReauth = ws.authenticated;
  if (!isReauth) {
    if (getConnectionCount(claims.userId) >= config.ws.maxConnectionsPerUser) {
      sendError(ws, 'Too many concurrent connections for this user', 'authenticate');
      ws.close(4003, 'Connection limit exceeded');
      return;
    }
    registerConnection(claims.userId, ws);
  }

  ws.authenticated = true;
  ws.userId = claims.userId;
  ws.username = claims.username;
  ws.displayName = claims.displayName;
  ws.tokenExp = claims.exp;

  recordHeartbeat(ws.userId);
  send(ws, { type: 'authenticated', userId: ws.userId, reauth: isReauth, presence: getAllStatuses() });
}

async function handleJoin(ws, frame) {
  const { channelId } = frame;
  if (typeof channelId !== 'string') {
    sendError(ws, 'join requires channelId', 'join');
    return;
  }
  try {
    // Re-validates membership every time, including on reconnect — a fresh
    // connection has no memory of any previous session's joins, so this is
    // never skipped as an "already checked" optimization (Section 3,
    // Authorization Model).
    await requireChannelMember(db, ws.userId, channelId);
  } catch {
    sendError(ws, 'Channel not found', 'join');
    return;
  }
  joinRoom(channelId, ws);
  send(ws, { type: 'joined', channelId });
}

function handleLeave(ws, frame) {
  const { channelId } = frame;
  if (typeof channelId === 'string') {
    leaveRoom(channelId, ws);
    send(ws, { type: 'left', channelId });
  }
}

async function handleMessage(ws, frame) {
  const { channelId } = frame;
  if (typeof channelId !== 'string') {
    sendError(ws, 'message requires channelId', 'message');
    return;
  }
  if (!ws.joinedChannels.has(channelId)) {
    sendError(ws, 'Join the channel before sending to it', 'message');
    return;
  }
  if (isMessageRateLimited(ws.userId)) {
    sendError(ws, 'Rate limit exceeded — slow down', 'message');
    return;
  }

  try {
    // Defense in depth: the join above already proved membership, but
    // re-checks here too in case it was revoked mid-session (removed from a
    // private channel) without the socket being told to leave.
    const channel = await requireChannelMember(db, ws.userId, channelId);
    // Same anti-drift principle as routes/messages.js's identical check —
    // the WS send path can't be a way to bypass what REST blocks.
    await requireWorkspaceNotArchived(db, channel.workspace_id);
    const message = await createMessage(db, {
      channelId,
      userId: ws.userId,
      username: ws.username,
      displayName: ws.displayName,
      content: frame.content,
      parentMessageId: frame.parentMessageId,
    });
    // clientNonce is opaque to the server — echoed back only so the
    // sender's own UI can match this confirmation to the optimistic message
    // it rendered locally before the round trip completed (Section 8, Phase
    // 3: "optimistic message rendering with server reconciliation"). Other
    // clients in the room receive it too but have no matching placeholder,
    // so they simply ignore it.
    broadcastToRoom(channelId, { type: 'message_created', message, clientNonce: frame.clientNonce ?? null });

    // Side effects of message creation, not part of it — see
    // routes/messages.js's identical call after its own broadcastToRoom, so
    // the two transports can't drift on when/how mention notifications or
    // entity linking fire. Both now go through a durable job queue
    // (FEATURE_REQUEST.md "hot path splitting" entry) processed by
    // workers/messageSideEffectsWorker.js, rather than running inline here.
    await enqueueMessageSideEffectJobs(db, { messageId: message.id, workspaceId: channel.workspace_id });

    // Same sibling-call pattern as above and as routes/messages.js's
    // identical REST-path call — semantic search (FEATURE_REQUEST.md entry
    // 1) ingestion can't be a way the WS send path silently diverges from
    // REST.
    await enqueueEmbeddingJob(db, message.id);
  } catch (err) {
    sendError(ws, err.message || 'Failed to send message', 'message');
  }
}
