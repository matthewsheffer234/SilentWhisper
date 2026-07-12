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

// Per-user, not per-IP (like llm/aiRateLimit.js's aiProxyRateLimiter) —
// requires requireAuth to already have populated req.user, since a
// currentPassword-guessing attempt only makes sense against one specific,
// already-authenticated account. Same 10/15min ceiling as
// loginUsernameLimiter's credential-guessing budget, applied here because a
// short-lived stolen access token is otherwise an unlimited number of
// currentPassword guesses against the real owner's account.
export const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `change-password:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Admin dashboard (FEATURE_REQUEST.md): account creation and another user's
// credential mutation are exactly the "authentication endpoints" category
// this file's other limiters already cover, regardless of who initiates
// them — keyed by the *admin's* req.user.id (not IP), same shape as
// changePasswordLimiter above.
export const adminUserCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `admin-user-create:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

export const adminPasswordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `admin-password-reset:${req.user.id}`,
  handler: jsonRateLimitHandler,
});
