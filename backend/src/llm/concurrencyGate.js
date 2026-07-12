// PROJECT_PLAN.md Section 3, Rate Limiting & Abuse Prevention: "Enforce
// LLM_MAX_CONCURRENT_REQUESTS as a global cap on in-flight AI proxy calls,
// independent of the per-user rate limit ... on the CPU-only Ollama-backed
// test environment, total inference throughput ... is the actual
// bottleneck." In-process state, same single-instance basis as the WS rate
// limiter and presence sweep — a hardware-capacity control, not a
// correctness guarantee that has to survive multiple backend instances.
//
// Non-blocking by design: acquire() either grants a slot immediately or
// refuses outright (the caller returns 503/429) rather than queuing —
// queuing would let requests pile up silently behind a single slow CPU-bound
// generation instead of surfacing "the AI service is busy" right away.
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
