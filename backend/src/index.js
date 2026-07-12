import express from 'express';
import { config } from './config.js';
import { db, checkDbConnection } from './db.js';
import { securityHeaders, corsMiddleware } from './middleware/security.js';

const app = express();

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json());

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
