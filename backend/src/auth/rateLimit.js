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

// Invitation creation (slice 2, FEATURE_REQUEST.md entry 1): same shape and
// ceiling as adminUserCreateLimiter — the same class of action (provisioning
// access for another person), keyed by the inviting actor rather than IP.
export const invitationCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `invitation-create:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Membership-invitation creation ("Live notification system..." entry):
// same shape and ceiling as invitationCreateLimiter above — the equivalent
// action for an existing account (propose membership, notify, await
// accept/decline) rather than a token-based invitation for a new one.
export const membershipInvitationCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `membership-invitation-create:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// FEATURE_REQUEST.md's @mention autocomplete entry: the first endpoint in
// this app designed to be hit on every keystroke rather than once per user
// action — per-user (not per-IP, like llm/aiRateLimit.js's
// aiProxyRateLimiter), since a channel-membership prefix search is cheap
// but the request volume is qualitatively different from every other
// limiter in this file. A much higher ceiling than aiProxyRateLimiter's
// 10-per-5-minutes reflects that cost difference — paired with client-side
// debouncing (ChannelView.jsx) so this ceiling is a backstop against a
// buggy/malicious client, not something normal typing speed would ever
// brush against.
export const memberSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `member-search:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Double-bracket entity autocomplete/resolve is the same keystroke-driven
// request class as member search: cheap, authenticated, and per-user, with
// client-side debounce as the first line and this limiter as abuse backstop.
export const entitySearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `entity-search:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// Inline task checkbox toggle (FEATURE_REQUEST.md entry 3) — not one of
// CLAUDE.md's three named-mandatory categories (auth/message-send/AI proxy),
// but it mutates shared message content on every request and costs nothing
// to add, so it follows the same convention as every other mutation route
// in this codebase rather than being the one write endpoint with no
// limiter. Ceiling sized like memberSearchLimiter/entitySearchLimiter —
// plausibly clicked in a quick burst (someone checking off several items in
// a row) but never at real per-keystroke volume.
export const taskToggleLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `task-toggle:${req.user.id}`,
  handler: jsonRateLimitHandler,
});

// FEATURE_REQUEST.md entry 5 (Admin Analytics Dashboard): shared by every
// route entries 5/6/7 add to routes/adminAnalytics.js — all aggregate SQL
// reads of similar cost over the same tables, gated on requireSystemAdmin, so
// a single admin-facing dashboard polling several tabs doesn't need
// per-tab budgets. Applied at the router level (adminAnalyticsRouter.use),
// not per-route like most limiters in this file, since every route here is
// the same class of read.
export const adminAnalyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: (req) => `admin-analytics:${req.user.id}`,
  handler: jsonRateLimitHandler,
});
