import 'dotenv/config';

function required(name, value) {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8000),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  db: {
    // Least-privilege runtime role (Section 5, Database Access Rights).
    // Migrations run separately using PG*-prefixed admin credentials — see knexfile.js.
    host: required('PGHOST', process.env.PGHOST),
    port: Number(process.env.PGPORT || 5432),
    user: required('APP_DB_USER', process.env.APP_DB_USER),
    password: required('APP_DB_PASSWORD', process.env.APP_DB_PASSWORD),
    database: required('PGDATABASE', process.env.PGDATABASE),
    // Scalability Target (PROJECT_PLAN.md Section 2): default to 20, not
    // sized 1:1 with concurrent users — Node's event loop multiplexes many
    // connections through a small pool.
    poolMin: Number(process.env.PG_POOL_MIN || 2),
    poolMax: Number(process.env.PG_POOL_MAX || 20),
  },

  auth: {
    jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET),
    // Embedded in each access token's header (kid). Bump this alongside
    // rotating JWT_SECRET so verification predictably rejects every token
    // signed under the old secret, rather than requiring a hard cutover
    // that logs everyone out at once with no way to distinguish why
    // (Section 3, Secrets & Configuration).
    jwtKeyId: process.env.JWT_KEY_ID || 'v1',
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTokenTtlMs: Number(process.env.REFRESH_TOKEN_TTL_MS || 30 * 24 * 60 * 60 * 1000), // 30 days
    bcryptSaltRounds: Math.max(12, Number(process.env.BCRYPT_SALT_ROUNDS || 12)),
  },

  ws: {
    // Configurable for reverse-proxy deployment (PROJECT_PLAN.md Section 8,
    // Phase 3: "Make the WebSocket path configurable").
    path: process.env.WS_PATH || '/ws',
    // A connection whose access token has expired and hasn't been renewed
    // via a fresh `authenticate` frame gets disconnected the next time this
    // sweep runs (Section 3, "Long-lived connections outlive the access
    // token"). Checked well inside the 15-minute access-token TTL.
    tokenExpirySweepIntervalMs: Number(process.env.WS_TOKEN_SWEEP_INTERVAL_MS || 30_000),
    // Presence heartbeat: a connection not heard from within this window is
    // downgraded from Online to Away (still connected, just stale) — server-
    // observed, never trusting a client-supplied timestamp (Section 6).
    presenceStaleMs: Number(process.env.WS_PRESENCE_STALE_MS || 45_000),
    presenceSweepIntervalMs: Number(process.env.WS_PRESENCE_SWEEP_INTERVAL_MS || 15_000),
    // Rate Limiting & Abuse Prevention (Section 3): bound both message-send
    // rate and total concurrent connections per user.
    maxMessagesPerWindow: Number(process.env.WS_MAX_MESSAGES_PER_WINDOW || 10),
    messageWindowMs: Number(process.env.WS_MESSAGE_WINDOW_MS || 10_000),
    maxConnectionsPerUser: Number(process.env.WS_MAX_CONNECTIONS_PER_USER || 5),
  },
};
