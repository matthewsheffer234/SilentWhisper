import helmet from 'helmet';
import cors from 'cors';
import { config } from '../config.js';

// Baseline security headers (PROJECT_PLAN.md Section 3, Transport & Headers):
// CSP with no unsafe-inline scripts and no third-party origins (this app
// never fetches external assets or CDNs — Rules of Engagement), plus
// nosniff and a same-origin referrer policy.
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  referrerPolicy: { policy: 'same-origin' },
});

// Narrow CORS to the configured origin(s) only (Section 3) — never a
// wildcard, since cookies will carry credentials starting Phase 2.
export const corsMiddleware = cors({
  origin: config.corsOrigin,
  credentials: true,
});
