import { config } from '../config.js';

// Fixed-window per-user counter for WebSocket message sends (PROJECT_PLAN.md
// Section 3, Rate Limiting & Abuse Prevention: "Rate-limit message sends per
// user/connection so a single client cannot flood a channel or overwhelm
// WebSocket broadcast fan-out"). Separate from express-rate-limit, which
// only applies to HTTP request/response — this is the equivalent guard for
// raw WS frames. In-process state is sufficient at the single-instance scale
// this targets (Scalability Target).
const windowByUser = new Map();

export function isMessageRateLimited(userId) {
  const now = Date.now();
  const entry = windowByUser.get(userId);

  if (!entry || now - entry.windowStart > config.ws.messageWindowMs) {
    windowByUser.set(userId, { windowStart: now, count: 1 });
    return false;
  }

  if (entry.count >= config.ws.maxMessagesPerWindow) {
    return true;
  }

  entry.count += 1;
  return false;
}

export function _resetForTests() {
  windowByUser.clear();
}
