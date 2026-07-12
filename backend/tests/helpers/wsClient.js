import WebSocket from 'ws';

export function connectWs(port, path = '/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

export function waitForMessage(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`Timed out waiting for WS message matching ${predicate}`));
    }, timeoutMs);

    function onMessage(raw) {
      const event = JSON.parse(raw.toString());
      if (predicate(event)) {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        resolve(event);
      }
    }
    ws.on('message', onMessage);
  });
}

export function waitForClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason?.toString() });
    });
  });
}

export function sendFrame(ws, frame) {
  ws.send(JSON.stringify(frame));
}
