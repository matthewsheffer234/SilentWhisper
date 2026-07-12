// Same shape as llm/concurrencyGate.js, deliberately a separate module-level
// counter (FEATURE_REQUEST.md entry 1: "configure ... concurrency
// separately from generation settings so summarization latency and
// embedding backlog do not starve each other"). The ingestion worker and the
// search route's query-embedding step share this one budget via
// search/embeddingService.js; llm/concurrencyGate.js's budget is untouched
// by either.
let inFlight = 0;

export function tryAcquire(maxConcurrent) {
  if (inFlight >= maxConcurrent) {
    return false;
  }
  inFlight += 1;
  return true;
}

export function release() {
  inFlight = Math.max(0, inFlight - 1);
}

export function getInFlightCount() {
  return inFlight;
}

export function _resetForTests() {
  inFlight = 0;
}
