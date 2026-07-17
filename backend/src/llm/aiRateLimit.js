import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// PROJECT_PLAN.md Section 3, Rate Limiting & Abuse Prevention: "Rate-limit
// AI proxy calls (summarize, extract tasks) per user. Local LLM inference is
// comparatively expensive, and an unbounded loop from a buggy or malicious
// client could starve the shared provider for every user on the host." This
// is separate from and additional to the global concurrency gate
// (concurrencyGate.js) — this bounds one user's request *rate*, the gate
// bounds total in-flight work across all users.
//
// requireAuth runs before this middleware on every AI route, so req.user is
// always populated by the time this keyGenerator runs.
const skipInTest = () => config.nodeEnv === 'test';

function jsonRateLimitHandler(_req, res) {
  res.status(429).json({ error: 'Too many AI requests. Please try again later.' });
}

export const aiProxyRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `ai:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Semantic search (FEATURE_REQUEST.md entry 1): same reasoning as
// aiProxyRateLimiter above ("each query triggers embedding work and a vector
// scan"), but a higher ceiling — a search is cheaper than a full generation
// (one embedding call, not a whole completion), so the budget that protects
// the shared provider from an unbounded loop doesn't need to be as tight.
export const semanticSearchRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `search:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Cross-channel workspace digest (FEATURE_REQUEST.md entry 6): "a stricter
// per-user digest rate limit because this endpoint can scan many channels
// and run multiple prompt batches" than aiProxyRateLimiter above — a single
// digest request does more selection/prompt work than one channel summary.
export const aiDigestRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `digest:${req.user.id}`,
  handler: jsonRateLimitHandler,
});
