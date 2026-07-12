import http from 'node:http';
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
import { aiRouter } from './routes/ai.js';
import { auditRouter } from './routes/audit.js';
import { searchRouter } from './routes/search.js';
import { attachWebSocketServer } from './ws/server.js';
import { startPresenceSweep, stopPresenceSweep } from './ws/presence.js';
import { ensureDefaultSettingsSeeded } from './llm/settingsService.js';
import { startHealthSweep, stopHealthSweep } from './llm/healthCheck.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './search/embeddingWorker.js';

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
app.use('/api', aiRouter);
app.use('/api', auditRouter);
app.use('/api', searchRouter);

app.use(errorHandler);

// HTTP and WebSocket share one server/port (config.ws.path, e.g. /ws) —
// simplest possible port topology for a reverse proxy to sit in front of,
// and keeps the WS path the only thing that needs to be configurable
// (PROJECT_PLAN.md Section 8, Phase 3).
function start(port = config.port) {
  const server = http.createServer(app);
  attachWebSocketServer(server);
  startPresenceSweep();
  startHealthSweep(db);
  // Not started under NODE_ENV=test: several test files call start() to get
  // a real listening server for WebSocket tests, without mocking
  // global.fetch (unlike the AI-route tests, which mock fetch but never
  // call start() at all). At this worker's poll interval (default 2s, far
  // shorter than llm.healthCheckIntervalMs's 60s — healthCheck's single
  // immediate fire-and-forget check on startup is tolerable; a repeating
  // 2s-interval sweep making real calls to the live Ollama instance for the
  // whole duration of an unrelated test file is not), an un-gated worker
  // would make real, repeated network calls against a real provider during
  // unrelated tests. Same skip-under-test instinct as
  // llm/aiRateLimit.js/ws/rateLimiter.js's skipInTest checks, applied here
  // at the sweep-start call site instead of inside a rate limiter. Worker
  // logic itself is still fully covered by tests/embeddingWorker.test.js,
  // which calls runEmbeddingWorkerTick directly with fetch mocked.
  if (config.nodeEnv !== 'test') {
    startEmbeddingWorker(db);
  }
  // Fire-and-forget: seeds app_settings.llm.* rows from env defaults for
  // admin-surface visibility. Not on the request path — getEffectiveSettings
  // (llm/settingsService.js) falls back to the same env defaults directly,
  // so accepting connections doesn't need to wait on this.
  ensureDefaultSettingsSeeded(db).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to seed default LLM settings:', err);
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Silent Whisper backend listening on :${port} (${config.nodeEnv}), ws path ${config.ws.path}`);
  });
  return server;
}

async function shutdown(server) {
  stopPresenceSweep();
  stopHealthSweep();
  stopEmbeddingWorker();
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
