import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// PROJECT_PLAN.md Section 3, Rate Limiting & Abuse Prevention: rate-limit
// login/signup per IP AND per username — an in-process limiter is sufficient
// at the single-instance scale this targets (Scalability Target). Two
// stacked limiters, not one: per-IP alone lets an attacker spread guesses
// across many usernames from one address; per-username alone lets a
// botnet rotate IPs against a single account. Both must hold.

function jsonRateLimitHandler(_req, res) {
  res.status(429).json({ error: 'Too many attempts. Please try again later.' });
}

// Skipped only under NODE_ENV=test (set by `npm test`, never in dev/prod).
// A real test suite legitimately signs up/logs in far more than 10-20 times
// per run from one "IP" (supertest's fixed local client address) — that's
// test volume, not the credential-stuffing pattern this limiter exists to
// catch, and letting the in-process limiter's shared state accumulate
// across a file's tests would make later tests fail on an unrelated 429
// rather than the thing they're actually testing.
const skipInTest = () => config.nodeEnv === 'test';

export const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: jsonRateLimitHandler,
});

export const loginUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `login:${String(req.body?.username || '').toLowerCase()}`,
  handler: jsonRateLimitHandler,
});

export const signupIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: jsonRateLimitHandler,
});
