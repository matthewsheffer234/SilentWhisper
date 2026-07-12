import { tryAcquire, release, getInFlightCount, _resetForTests } from '../src/llm/concurrencyGate.js';

// PROJECT_PLAN.md Section 8, Phase 4: "Add tests for ... the concurrency
// cap ..." — LLM_MAX_CONCURRENT_REQUESTS is enforced as a global, in-process
// cap independent of per-user rate limiting (Section 3).

beforeEach(() => {
  _resetForTests();
});

test('grants slots up to the configured max, then refuses', () => {
  expect(tryAcquire(2)).toBe(true);
  expect(tryAcquire(2)).toBe(true);
  expect(getInFlightCount()).toBe(2);
  expect(tryAcquire(2)).toBe(false);
  expect(getInFlightCount()).toBe(2);
});

test('release frees a slot for the next caller', () => {
  expect(tryAcquire(1)).toBe(true);
  expect(tryAcquire(1)).toBe(false);
  release();
  expect(getInFlightCount()).toBe(0);
  expect(tryAcquire(1)).toBe(true);
});

test('release never goes negative', () => {
  release();
  release();
  expect(getInFlightCount()).toBe(0);
});
