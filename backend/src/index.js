import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { db, checkDbConnection } from './db.js';
import { securityHeaders, corsMiddleware } from './middleware/security.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { workspacesRouter } from './routes/workspaces.js';
import { directMessagesRouter, groupDirectMessagesRouter } from './routes/directMessages.js';
import { messagesRouter } from './routes/messages.js';

const app = express();

// One hop of trust (the shared nginx proxy in front of this stack) — makes
// req.ip reflect the real client address from X-Forwarded-For for audit
// actor_ip and rate-limiter keying (Section 3, Transport & Headers), while
// still working correctly in local dev with no proxy in front at all.
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json());
app.use(cookieParser());

// Plain /health — no path-prefix collision risk since Silent Whisper owns
// its whole subdomain (PROJECT_PLAN.md Section 2, Serving Under Silent
// Lattice).
app.get('/health', async (_req, res) => {
  try {
    await checkDbConnection();
    res.json({ status: 'ok', db: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', message: err.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/direct-messages', directMessagesRouter);
app.use('/api/group-direct-messages', groupDirectMessagesRouter);
app.use('/api', messagesRouter);

app.use(errorHandler);

function start() {
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Silent Whisper backend listening on :${config.port} (${config.nodeEnv})`);
  });
  return server;
}

async function shutdown(server) {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const server = start();
  process.on('SIGTERM', () => shutdown(server).then(() => process.exit(0)));
  process.on('SIGINT', () => shutdown(server).then(() => process.exit(0)));
}

export { app, start, shutdown };
