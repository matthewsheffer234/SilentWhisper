import { config } from '../config.js';
import { broadcastToAllAuthenticated, getConnectionCount } from './connectionRegistry.js';

// Server-observed presence only — never a client-supplied timestamp
// (PROJECT_PLAN.md Section 6, Presence Engine). `online`/`away` are the two
// states the plan specifies for a currently-connected user; `offline` here
// just means "no longer tracked at all" (zero open connections), which is
// the signal other clients need to stop showing a badge — it isn't a third
// connected-state value, it's the absence of one.

// userId -> { lastHeartbeat: number (ms), status: 'online' | 'away' }
const presenceByUser = new Map();

function broadcastPresence(userId, status) {
  broadcastToAllAuthenticated({ type: 'presence_update', userId, status });
}

// Called on successful authenticate and on every heartbeat frame.
export function recordHeartbeat(userId) {
  const existing = presenceByUser.get(userId);
  presenceByUser.set(userId, { lastHeartbeat: Date.now(), status: 'online' });
  if (!existing || existing.status !== 'online') {
    broadcastPresence(userId, 'online');
  }
}

// Called when a user's last open connection closes.
export function handleDisconnect(userId) {
  if (getConnectionCount(userId) > 0) {
    // Other tabs/devices for the same user are still connected.
    return;
  }
  presenceByUser.delete(userId);
  broadcastPresence(userId, 'offline');
}

export function getStatus(userId) {
  return presenceByUser.get(userId)?.status ?? 'offline';
}

export function getAllStatuses() {
  return Object.fromEntries([...presenceByUser.entries()].map(([userId, v]) => [userId, v.status]));
}

// Downgrades any user whose heartbeat has gone stale from online -> away.
// Run on a timer (startPresenceSweep), not on every request, since presence
// is a background concern independent of any single connection's activity.
export function sweepStalePresence() {
  const now = Date.now();
  for (const [userId, entry] of presenceByUser.entries()) {
    if (entry.status === 'online' && now - entry.lastHeartbeat > config.ws.presenceStaleMs) {
      entry.status = 'away';
      broadcastPresence(userId, 'away');
    }
  }
}

let sweepTimer = null;

export function startPresenceSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(sweepStalePresence, config.ws.presenceSweepIntervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopPresenceSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function _resetForTests() {
  presenceByUser.clear();
  stopPresenceSweep();
}
