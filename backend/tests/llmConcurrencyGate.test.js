import { jest } from '@jest/globals';
import { config } from '../src/config.js';
import { acquireSlot, release, getInFlightCount, getQueueDepth, _resetForTests } from '../src/llm/concurrencyGate.js';

// PROJECT_PLAN.md Section 8, Phase 4 / FEATURE_REQUEST.md entry 2:
// LLM_MAX_CONCURRENT_REQUESTS is enforced as a global, in-process cap
// independent of per-user rate limiting (Section 3) — and, since entry 2,
// a request beyond that cap waits in a bounded FIFO queue instead of being
// refused outright.

beforeEach(() => {
  _resetForTests();
});

test('grants a slot immediately when under the max, without queuing', async () => {
  const onQueued = jest.fn();
  await acquireSlot(2, { onQueued });
  expect(getInFlightCount()).toBe(1);
  expect(getQueueDepth()).toBe(0);
  expect(onQueued).not.toHaveBeenCalled();
});

test('a second request beyond the max queues rather than being refused, with a 1-based position', async () => {
  await acquireSlot(1);
  expect(getInFlightCount()).toBe(1);

  const onQueued = jest.fn();
  let granted = false;
  const p = acquireSlot(1, { onQueued }).then(() => {
    granted = true;
  });

  // onQueued fires synchronously inside the Promise executor, before this
  // line even runs — no need to await a tick first.
  expect(onQueued).toHaveBeenCalledWith(1);
  expect(getQueueDepth()).toBe(1);
  expect(granted).toBe(false);

  release();
  await p;
  expect(granted).toBe(true);
  expect(getQueueDepth()).toBe(0);
  expect(getInFlightCount()).toBe(1);
});

test('queued requests are granted slots in FIFO order as they free up', async () => {
  await acquireSlot(1); // first slot, granted immediately

  const order = [];
  const onQueued2 = jest.fn((position) => order.push(`queued:2:${position}`));
  const p2 = acquireSlot(1, { onQueued: onQueued2 }).then(() => order.push('granted:2'));
  const onQueued3 = jest.fn((position) => order.push(`queued:3:${position}`));
  const p3 = acquireSlot(1, { onQueued: onQueued3 }).then(() => order.push('granted:3'));

  expect(onQueued2).toHaveBeenCalledWith(1);
  expect(onQueued3).toHaveBeenCalledWith(2);
  expect(getQueueDepth()).toBe(2);

  release(); // frees the original holder's slot -> transfers to #2, not a fresh acquire
  await p2;
  expect(getInFlightCount()).toBe(1);
  expect(getQueueDepth()).toBe(1);

  release(); // -> transfers to #3
  await p3;
  expect(getQueueDepth()).toBe(0);
  expect(getInFlightCount()).toBe(1);

  expect(order).toEqual(['queued:2:1', 'queued:3:2', 'granted:2', 'granted:3']);
});

test('rejects immediately once the wait queue is already at the configured max depth', async () => {
  await acquireSlot(1); // occupy the only slot

  const waiters = [];
  for (let i = 0; i < config.llm.queueMaxDepth; i += 1) {
    waiters.push(acquireSlot(1));
  }
  expect(getQueueDepth()).toBe(config.llm.queueMaxDepth);

  await expect(acquireSlot(1)).rejects.toThrow();
  // The rejected arrival was never queued — depth is unchanged.
  expect(getQueueDepth()).toBe(config.llm.queueMaxDepth);

  // Drain everything so nothing dangles across tests.
  for (let i = 0; i <= config.llm.queueMaxDepth; i += 1) release();
  await Promise.all(waiters);
});

test('release with nothing queued decrements inFlight and never goes negative', () => {
  release();
  expect(getInFlightCount()).toBe(0);
});
