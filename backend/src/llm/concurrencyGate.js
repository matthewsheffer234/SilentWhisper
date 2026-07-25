import { config } from '../config.js';

// PROJECT_PLAN.md Section 3, Rate Limiting & Abuse Prevention: "Enforce
// LLM_MAX_CONCURRENT_REQUESTS as a global cap on in-flight AI proxy calls,
// independent of the per-user rate limit ... on the CPU-only Ollama-backed
// test environment, total inference throughput ... is the actual
// bottleneck." In-process state, same single-instance basis as the WS rate
// limiter and presence sweep — a hardware-capacity control, not a
// correctness guarantee that has to survive multiple backend instances.
//
// FEATURE_REQUEST.md entry 2: a request beyond maxConcurrent now waits in a
// bounded in-memory FIFO queue rather than being refused outright — surfaces
// a client-visible "queued, position N" state instead of a silent 503 the
// moment two people click an AI action within the same generation window.
// Only the queue depth is bounded (config.llm.queueMaxDepth); once that's
// full, a new arrival still gets rejected immediately, same as before.
let inFlight = 0;
let queue = []; // FIFO array of { resolve } entries — see acquireSlot below.

export function getInFlightCount() {
  return inFlight;
}

export function getQueueDepth() {
  return queue.length;
}

// Resolves once a slot is actually granted — immediately if one is free,
// otherwise once release() below works through the queue far enough to reach
// this caller. onQueued, if given, fires synchronously (before this function
// returns) with this request's 1-based position the moment it's queued —
// never called for a request granted a slot immediately.
//
// docs/reviews/2026-07-25-consolidated-meta-review.md finding #2 (SEC-02/
// PERF-01/MAINT-01, independently flagged by three separate reviews): every
// AI route already builds an AbortController tied to `res.on('close', ...)`
// and threads its `signal` through to the adapter call, but previously
// nothing passed that signal into acquireSlot itself — a client that
// disconnected while queued stayed queued, then consumed a real generation
// slot (LLM_MAX_CONCURRENT_REQUESTS defaults to 1) once its turn came, wasting
// scarce CPU-only-Ollama capacity on a response nobody would ever receive.
// `signal` is optional so existing non-cancellable callers keep working
// unmodified.
export function acquireSlot(maxConcurrent, { onQueued, signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(new Error('AI request aborted'));
  }

  if (inFlight < maxConcurrent) {
    inFlight += 1;
    return Promise.resolve();
  }

  if (queue.length >= config.llm.queueMaxDepth) {
    return Promise.reject(new Error('AI queue is full'));
  }

  return new Promise((resolve, reject) => {
    const entry = { resolve };
    function onAbort() {
      // Only removes THIS entry — a stale/already-fired listener from a
      // slot this same entry already received can't run twice, since
      // entry.resolve below detaches it the moment the slot is granted.
      queue = queue.filter((queued) => queued !== entry);
      reject(new Error('AI request aborted'));
    }
    // Reassigned (not the original `resolve`) so release() below can grant
    // the slot without also needing to know about abort cleanup.
    entry.resolve = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(entry);
    onQueued?.(queue.length);
  });
}

export function release() {
  const next = queue.shift();
  if (next) {
    // The freed slot transfers directly to the longest-waiting queued
    // request — inFlight stays exactly where it was rather than being
    // decremented and then immediately re-incremented, which would leave a
    // window for a brand-new (non-queued) caller to jump the FIFO line.
    next.resolve();
    return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

export function _resetForTests() {
  inFlight = 0;
  queue = [];
}
