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

// docs/reviews/2026-07-25-consolidated-meta-review.md finding #2
// (SEC-02/PERF-01/MAINT-01): a queued request must be removable via its
// AbortSignal instead of sitting in the FIFO until granted a slot it'll
// never use.
describe('cancellation via AbortSignal', () => {
  test('an already-aborted signal rejects immediately without granting or queuing a slot', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(acquireSlot(2, { signal: controller.signal })).rejects.toThrow('AI request aborted');
    expect(getInFlightCount()).toBe(0);
    expect(getQueueDepth()).toBe(0);
  });

  test('a queued request removes itself and rejects when its signal aborts, without consuming a future slot', async () => {
    await acquireSlot(1); // occupy the only slot
    const controller = new AbortController();
    const queued = acquireSlot(1, { signal: controller.signal });
    expect(getQueueDepth()).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow('AI request aborted');
    expect(getQueueDepth()).toBe(0);
    expect(getInFlightCount()).toBe(1); // original holder is unaffected

    release(); // nothing left queued -> the slot just frees, nobody claims it
    expect(getInFlightCount()).toBe(0);
  });

  test('FIFO order is preserved for remaining entries when a queued entry in the middle aborts', async () => {
    await acquireSlot(1); // slot held by the first caller

    const order = [];
    const p1 = acquireSlot(1).then(() => order.push('granted:1'));
    const controller2 = new AbortController();
    const p2 = acquireSlot(1, { signal: controller2.signal }).catch(() => order.push('aborted:2'));
    const p3 = acquireSlot(1).then(() => order.push('granted:3'));
    expect(getQueueDepth()).toBe(3);

    controller2.abort();
    await p2;
    expect(getQueueDepth()).toBe(2);

    release(); // -> p1
    await p1;
    release(); // -> p3
    await p3;

    expect(order).toEqual(['aborted:2', 'granted:1', 'granted:3']);
  });

  test('aborting after a queued request already received its slot is a harmless no-op', async () => {
    await acquireSlot(1);
    const controller = new AbortController();
    const queued = acquireSlot(1, { signal: controller.signal });

    release(); // transfers the slot to the queued entry
    await queued;
    expect(getInFlightCount()).toBe(1);
    expect(getQueueDepth()).toBe(0);

    expect(() => controller.abort()).not.toThrow();
    expect(getInFlightCount()).toBe(1);
    expect(getQueueDepth()).toBe(0);

    release();
    expect(getInFlightCount()).toBe(0);
  });
});
