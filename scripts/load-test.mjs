#!/usr/bin/env node
// PROJECT_PLAN.md Section 2, Scalability Target: "Load-test the WebSocket
// and REST layers at 100 simulated concurrent users before Phase 5 is
// considered complete, and record observed p95 message-delivery latency and
// API response times as a baseline for future capacity planning."
//
// Deliberately bypasses the signup/login REST endpoints entirely: those are
// rate-limited by IP (signupIpLimiter: 10/hour, loginIpLimiter: 20/15min —
// backend/src/auth/rateLimit.js), which is correct production behavior but
// would make a 100-simulated-user run from one machine impossible without
// weakening a control this app deliberately has and already has its own
// test coverage for (auth.test.js). Instead: seed users, a workspace, and a
// channel directly in Postgres (as the same least-privilege app_runtime_user
// role the backend itself connects as — Section 5's grants already cover
// every insert this needs), and mint access tokens directly with the same
// JWT_SECRET/JWT_KEY_ID the backend verifies against. This exercises exactly
// the layers Section 2 asks for — WebSocket connection/auth/join/broadcast
// and REST message read/write — without exercising or bending the auth
// rate limiters, which are a different, already-tested concern.

import dotenv from 'dotenv';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const NUM_USERS = Number(process.env.LOAD_TEST_USERS || 100);
const API_BASE = process.env.LOAD_TEST_API_BASE || 'http://localhost:8101/api';
const WS_URL = process.env.LOAD_TEST_WS_URL || 'ws://localhost:8101/ws';
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION_SECONDS || 30);
const MESSAGES_PER_USER = Number(process.env.LOAD_TEST_MESSAGES_PER_USER || 5);
// A minority of users send over REST instead of WS, so both send paths get
// exercised concurrently under the same load, matching Section 2's "up to
// 100 concurrent active users (concurrent WebSocket connections plus
// concurrent REST traffic)" framing.
const REST_SENDER_FRACTION = Number(process.env.LOAD_TEST_REST_FRACTION || 0.2);
const RUN_ID = Date.now();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (expected in backend/.env on the host, or already injected via Docker Compose/the container environment when run inside a container)`);
    process.exit(2);
  }
  return value;
}

function signToken(userId, username) {
  return jwt.sign({ sub: userId, username }, requireEnv('JWT_SECRET'), {
    expiresIn: process.env.ACCESS_TOKEN_TTL || '15m',
    keyid: process.env.JWT_KEY_ID || 'v1',
  });
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

function summarize(label, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${sorted.length} p50=${percentile(sorted, 50)?.toFixed(1)}ms p95=${percentile(sorted, 95)?.toFixed(1)}ms p99=${percentile(sorted, 99)?.toFixed(1)}ms max=${sorted[sorted.length - 1]?.toFixed(1)}ms`,
  );
}

async function seed(pgClient) {
  const ownerId = crypto.randomUUID();
  const ownerUsername = `loadtest_owner_${RUN_ID}`;
  // Placeholder only — this script never logs in via password, it mints
  // tokens directly, so the hash's actual value is irrelevant beyond
  // satisfying the NOT NULL/VARCHAR(255) column constraints (Section 4).
  const placeholderHash = `loadtest-unused-${crypto.randomBytes(16).toString('hex')}`;

  await pgClient.query('INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)', [
    ownerId,
    ownerUsername,
    `${ownerUsername}@example.com`,
    placeholderHash,
  ]);

  const workspaceRes = await pgClient.query(
    'INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id',
    [`Load Test ${RUN_ID}`, ownerId],
  );
  const workspaceId = workspaceRes.rows[0].id;
  await pgClient.query('INSERT INTO workspace_members (workspace_id, user_id, system_role) VALUES ($1, $2, $3)', [
    workspaceId,
    ownerId,
    'ADMIN',
  ]);

  const channelRes = await pgClient.query(
    "INSERT INTO channels (workspace_id, name, type) VALUES ($1, $2, 'PUBLIC') RETURNING id",
    [workspaceId, 'load-test'],
  );
  const channelId = channelRes.rows[0].id;
  await pgClient.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, ownerId]);

  const users = [];
  for (let i = 0; i < NUM_USERS; i += 1) {
    const userId = crypto.randomUUID();
    const username = `loadtest_user_${RUN_ID}_${i}`;
    // eslint-disable-next-line no-await-in-loop
    await pgClient.query('INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)', [
      userId,
      username,
      `${username}@example.com`,
      placeholderHash,
    ]);
    // eslint-disable-next-line no-await-in-loop
    await pgClient.query('INSERT INTO workspace_members (workspace_id, user_id, system_role) VALUES ($1, $2, $3)', [
      workspaceId,
      userId,
      'MEMBER',
    ]);
    // eslint-disable-next-line no-await-in-loop
    await pgClient.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, userId]);
    users.push({ userId, username, accessToken: signToken(userId, username) });
  }

  return { workspaceId, channelId, ownerUsername, users };
}

async function cleanup(pgClient) {
  // Scoped to the 'loadtest_' username prefix only — never a blanket
  // delete, so this never touches real data even run against a non-empty
  // dev database. Not narrowed to this run's own RUN_ID specifically, so it
  // also mops up any previous run's rows left behind by an interrupted run
  // (e.g. Ctrl-C before cleanup ran) rather than accumulating forever.
  await pgClient.query(
    "DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loadtest\\_%' ESCAPE '\\')",
  );
  await pgClient.query(
    "DELETE FROM channel_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loadtest\\_%' ESCAPE '\\')",
  );
  await pgClient.query(
    "DELETE FROM workspace_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loadtest\\_%' ESCAPE '\\')",
  );
  await pgClient.query("DELETE FROM channels WHERE name = 'load-test'");
  await pgClient.query(`DELETE FROM workspaces WHERE name LIKE 'Load Test %'`);
  await pgClient.query("DELETE FROM users WHERE username LIKE 'loadtest\\_%' ESCAPE '\\'");
}

function connectAndJoin(user, channelId, metrics) {
  return new Promise((resolve, reject) => {
    const connectStart = performance.now();
    const ws = new WebSocket(WS_URL);
    const pendingSends = new Map(); // clientNonce -> sendStartMs

    const timeout = setTimeout(() => {
      reject(new Error(`${user.username}: connect/auth/join timed out`));
    }, 15_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'authenticate', accessToken: user.accessToken }));
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame.type === 'authenticated') {
        ws.send(JSON.stringify({ type: 'join', channelId }));
        return;
      }
      if (frame.type === 'joined') {
        clearTimeout(timeout);
        metrics.connectionSetupMs.push(performance.now() - connectStart);
        resolve({ ws, pendingSends });
        return;
      }
      if (frame.type === 'message_created' && frame.clientNonce && pendingSends.has(frame.clientNonce)) {
        const sentAt = pendingSends.get(frame.clientNonce);
        pendingSends.delete(frame.clientNonce);
        metrics.wsRoundTripMs.push(performance.now() - sentAt);
      }
      if (frame.type === 'error') {
        console.error(`${user.username} ws error frame:`, frame.error, frame.context);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function runSendPhase({ users, connections, channelId, metrics, restSenderUserIds }) {
  const sendPromises = [];

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const { ws, pendingSends } = connections[i];
    const isRestSender = restSenderUserIds.has(user.userId);

    for (let m = 0; m < MESSAGES_PER_USER; m += 1) {
      const delayMs = Math.random() * DURATION_SECONDS * 1000;
      const p = new Promise((resolve) => {
        setTimeout(async () => {
          if (isRestSender) {
            const start = performance.now();
            try {
              const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
                body: JSON.stringify({ content: `load test message ${m} from ${user.username}` }),
              });
              await res.json().catch(() => null);
              if (res.ok) {
                metrics.restPostMs.push(performance.now() - start);
              } else {
                metrics.restPostErrors += 1;
              }
            } catch {
              metrics.restPostErrors += 1;
            }
          } else {
            const clientNonce = crypto.randomUUID();
            pendingSends.set(clientNonce, performance.now());
            ws.send(
              JSON.stringify({
                type: 'message',
                channelId,
                content: `load test message ${m} from ${user.username}`,
                clientNonce,
              }),
            );
          }
          resolve();
        }, delayMs);
      });
      sendPromises.push(p);
    }

    // A handful of users also poll the message history over REST during the
    // run, to sample GET latency under the same concurrent load.
    if (i % 10 === 0) {
      const p = new Promise((resolve) => {
        setTimeout(async () => {
          const start = performance.now();
          try {
            const res = await fetch(`${API_BASE}/channels/${channelId}/messages?limit=20`, {
              headers: { Authorization: `Bearer ${user.accessToken}` },
            });
            await res.json().catch(() => null);
            if (res.ok) {
              metrics.restGetMs.push(performance.now() - start);
            }
          } catch {
            // Ignored — GET sampling is best-effort telemetry, not part of the pass/fail surface.
          }
          resolve();
        }, Math.random() * DURATION_SECONDS * 1000);
      });
      sendPromises.push(p);
    }
  }

  await Promise.all(sendPromises);
  // Grace period for the last WS round trips to arrive after their sends.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function main() {
  const pgClient = new pg.Client({
    host: requireEnv('PGHOST'),
    port: Number(process.env.PGPORT || 5432),
    user: requireEnv('APP_DB_USER'),
    password: requireEnv('APP_DB_PASSWORD'),
    database: requireEnv('PGDATABASE'),
  });
  await pgClient.connect();

  console.log(`Silent Whisper load test — ${NUM_USERS} simulated users, ${DURATION_SECONDS}s send window`);
  console.log(`API: ${API_BASE}  WS: ${WS_URL}`);

  let seeded;
  try {
    console.log('Seeding users, workspace, and channel...');
    seeded = await seed(pgClient);

    const metrics = { connectionSetupMs: [], wsRoundTripMs: [], restPostMs: [], restGetMs: [], restPostErrors: 0 };
    const restSenderUserIds = new Set(
      seeded.users.filter(() => Math.random() < REST_SENDER_FRACTION).map((u) => u.userId),
    );

    console.log(`Opening ${NUM_USERS} concurrent WebSocket connections (authenticate + join)...`);
    const connectStart = performance.now();
    const connections = await Promise.all(
      seeded.users.map((user) => connectAndJoin(user, seeded.channelId, metrics)),
    );
    console.log(`All connections authenticated and joined in ${(performance.now() - connectStart).toFixed(0)}ms`);

    console.log(
      `Running send phase: ~${MESSAGES_PER_USER} messages/user over ${DURATION_SECONDS}s (${Math.round(REST_SENDER_FRACTION * 100)}% of users sending via REST, the rest via WebSocket)...`,
    );
    await runSendPhase({ users: seeded.users, connections, channelId: seeded.channelId, metrics, restSenderUserIds });

    for (const { ws } of connections) {
      ws.close();
    }

    console.log('\n--- Results ---');
    summarize('WebSocket connect+authenticate+join', metrics.connectionSetupMs);
    summarize('WebSocket message round trip (send -> broadcast receipt)', metrics.wsRoundTripMs);
    summarize('REST POST /channels/:id/messages', metrics.restPostMs);
    summarize('REST GET /channels/:id/messages', metrics.restGetMs);
    if (metrics.restPostErrors > 0) {
      console.log(`  REST POST errors: ${metrics.restPostErrors}`);
    }
    const totalWsMessagesUnmatched = connections.reduce((sum, c) => sum + c.pendingSends.size, 0);
    if (totalWsMessagesUnmatched > 0) {
      console.log(`  WARNING: ${totalWsMessagesUnmatched} WS message send(s) never got a matching broadcast back.`);
    }
  } finally {
    console.log('\nCleaning up seeded load-test data...');
    await cleanup(pgClient);
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('load-test failed:', err);
  process.exit(1);
});
