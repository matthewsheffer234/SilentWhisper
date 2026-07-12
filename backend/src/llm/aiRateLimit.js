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
