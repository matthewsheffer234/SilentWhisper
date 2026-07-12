import { getAccessToken, refreshAccessToken } from '../api/client.js';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';

// Re-authenticate well before the 15-minute access token expires (Section 3,
// WebSocket Authentication Handshake: "Long-lived connections outlive the
// access token") — renews the token via the same silent-refresh path the
// REST client uses, then sends a fresh `authenticate` frame over the
// existing socket rather than reconnecting.
const REAUTH_INTERVAL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 20 * 1000;
const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export function createSocket() {
  let ws = null;
  let reconnectAttempt = 0;
  let reauthTimer = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let explicitlyClosed = false;
  const listeners = new Map();

  function emit(type, payload) {
    for (const handler of listeners.get(type) ?? []) {
      handler(payload);
    }
  }

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type)?.delete(handler);
  }

  function send(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  function scheduleReconnect() {
    if (explicitlyClosed) return;
    // Exponential backoff with jitter — avoids every client hammering the
    // server with reconnects at once after a restart (a thundering herd is
    // exactly the load spike this is meant to prevent).
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** reconnectAttempt);
    const jitter = Math.random() * backoff * 0.3;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connect, backoff + jitter);
  }

  function connect() {
    explicitlyClosed = false;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      send({ type: 'authenticate', accessToken: getAccessToken() });
    };

    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type === 'authenticated') {
        reconnectAttempt = 0;
      }
      emit(frame.type, frame);
      emit('*', frame);
    };

    ws.onclose = () => {
      clearInterval(heartbeatTimer);
      clearInterval(reauthTimer);
      emit('disconnected', {});
      scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' always follows 'error' for browser WebSocket — reconnect
      // logic lives in onclose only, to avoid double-scheduling.
    };

    heartbeatTimer = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);
    reauthTimer = setInterval(async () => {
      const token = await refreshAccessToken();
      if (token) send({ type: 'authenticate', accessToken: token });
    }, REAUTH_INTERVAL_MS);
  }

  function disconnect() {
    explicitlyClosed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearInterval(reauthTimer);
    ws?.close();
  }

  return { connect, disconnect, send, on };
}
