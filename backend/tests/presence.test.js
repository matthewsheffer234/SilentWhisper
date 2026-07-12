import { jest } from '@jest/globals';
import { config } from '../src/config.js';
import { recordHeartbeat, handleDisconnect, getStatus, sweepStalePresence, _resetForTests } from '../src/ws/presence.js';
import { _resetForTests as resetConnectionRegistry } from '../src/ws/connectionRegistry.js';

// Isolated from the full WS server so the online -> away staleness
// transition can be tested deterministically with fake time instead of
// waiting out a real presenceStaleMs window (PROJECT_PLAN.md Section 6,
// Presence Engine).
beforeEach(() => {
  _resetForTests();
  resetConnectionRegistry();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a heartbeat marks a user online', () => {
  recordHeartbeat('user-1');
  expect(getStatus('user-1')).toBe('online');
});

test('a stale heartbeat is downgraded to away on sweep, not before', () => {
  recordHeartbeat('user-2');
  expect(getStatus('user-2')).toBe('online');

  jest.advanceTimersByTime(config.ws.presenceStaleMs - 1000);
  sweepStalePresence();
  expect(getStatus('user-2')).toBe('online');

  jest.advanceTimersByTime(2000);
  sweepStalePresence();
  expect(getStatus('user-2')).toBe('away');
});

test('a fresh heartbeat brings an away user back online immediately', () => {
  recordHeartbeat('user-3');
  jest.advanceTimersByTime(config.ws.presenceStaleMs + 1000);
  sweepStalePresence();
  expect(getStatus('user-3')).toBe('away');

  recordHeartbeat('user-3');
  expect(getStatus('user-3')).toBe('online');
});

test('a user with no open connections is removed from presence entirely on disconnect', () => {
  recordHeartbeat('user-4');
  expect(getStatus('user-4')).toBe('online');

  // connectionRegistry has no registered sockets for 'user-4' in this
  // isolated test, so getConnectionCount is 0 and the disconnect proceeds.
  handleDisconnect('user-4');
  expect(getStatus('user-4')).toBe('offline');
});

test('an untracked user reports offline', () => {
  expect(getStatus('never-seen')).toBe('offline');
});
