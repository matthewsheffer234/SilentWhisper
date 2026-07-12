import { tryAcquire, release, getInFlightCount, _resetForTests } from '../src/search/embeddingConcurrencyGate.js';

// FEATURE_REQUEST.md entry 1: a separate concurrency budget from
// llm/concurrencyGate.js (see llmConcurrencyGate.test.js for that gate's
// identical shape) — "configure ... concurrency separately from generation
// settings so summarization latency and embedding backlog do not starve
// each other."

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
