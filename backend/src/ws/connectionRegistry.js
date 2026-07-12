// In-memory only — valid because the deployment target is a single Node.js
// instance (PROJECT_PLAN.md Section 2, Scalability Target: "Presence and
// room-membership state may live in backend process memory... Do not
// introduce a multi-instance requirement without also introducing a shared
// state store"). If this ever runs as more than one instance, this module is
// exactly the thing that would need to move to Redis pub/sub.

// userId -> Set<ws>
const userConnections = new Map();
// channelId -> Set<ws>
const channelRooms = new Map();

export function registerConnection(userId, ws) {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId).add(ws);
}

export function unregisterConnection(userId, ws) {
  const set = userConnections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    userConnections.delete(userId);
  }
}

export function getConnectionCount(userId) {
  return userConnections.get(userId)?.size ?? 0;
}

export function getUserConnections(userId) {
  return userConnections.get(userId) ?? new Set();
}

export function getConnectedUserIds() {
  return [...userConnections.keys()];
}

export function joinRoom(channelId, ws) {
  if (!channelRooms.has(channelId)) {
    channelRooms.set(channelId, new Set());
  }
  channelRooms.get(channelId).add(ws);
  ws.joinedChannels.add(channelId);
}

export function leaveRoom(channelId, ws) {
  const set = channelRooms.get(channelId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      channelRooms.delete(channelId);
    }
  }
  ws.joinedChannels.delete(channelId);
}

// Called on disconnect so a dead socket can't linger in any room.
export function leaveAllRooms(ws) {
  for (const channelId of [...ws.joinedChannels]) {
    leaveRoom(channelId, ws);
  }
}

export function broadcastToRoom(channelId, event, { excludeWs } = {}) {
  const set = channelRooms.get(channelId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const ws of set) {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

export function broadcastToAllAuthenticated(event) {
  const payload = JSON.stringify(event);
  for (const set of userConnections.values()) {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }
}

// Test-only: clears all in-memory state between test files/runs.
export function _resetForTests() {
  userConnections.clear();
  channelRooms.clear();
}
