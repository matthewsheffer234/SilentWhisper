import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { _resetForTests as resetHealthStatus } from '../src/llm/healthCheck.js';

// FEATURE_REQUEST.md entry 3: GET /health/live is liveness-only (no DB or
// provider touch); GET /health gains an additive `ai` field reusing the
// health sweep's already-cached status rather than triggering a new
// provider call.
//
// CHANGELOG.md / RUNBOOK.md "Enclave Upgrade": both endpoints also report
// `version` (config.version — SILENTWHISPER_VERSION, falling back to
// backend/package.json's own version), so a running instance can always
// self-report exactly what was installed.

// db.raw is a non-writable (but configurable) property on the knex instance
// — jest.spyOn's direct-assignment path can't touch it, so it's swapped out
// and restored via defineProperty instead.
const realDbRaw = db.raw;
function mockDbRaw(impl) {
  Object.defineProperty(db, 'raw', { value: impl, configurable: true, writable: false });
}
function restoreDbRaw() {
  Object.defineProperty(db, 'raw', { value: realDbRaw, configurable: true, writable: false });
}

afterEach(() => {
  jest.restoreAllMocks();
  resetHealthStatus();
  restoreDbRaw();
});

afterAll(async () => {
  await db.destroy();
});

describe('GET /health/live', () => {
  test('returns ok without touching the database', async () => {
    const rawFn = jest.fn(realDbRaw);
    mockDbRaw(rawFn);
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: config.version });
    expect(rawFn).not.toHaveBeenCalled();
  });

  test('still returns 200 when the database is unreachable', async () => {
    mockDbRaw(() => Promise.reject(new Error('simulated db outage')));
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: config.version });
  });
});

describe('GET /health', () => {
  test('includes db and ai fields, ai reflecting the cached sweep result', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(config.version);
    expect(res.body.db).toBe('ok');
    expect(res.body.ai).toEqual({
      healthy: false,
      message: 'not checked yet',
      provider: 'ollama',
      lastCheckedAt: null,
    });
    expect(typeof res.body.uptimeSeconds).toBe('number');
    // The route reuses the periodic sweep's cached status — it must never
    // itself trigger a new outbound provider health check.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('ai.healthy:false never flips the top-level status/HTTP code', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ai.healthy).toBe(false);
  });

  test('returns 503 when the database is unreachable, independent of ai status', async () => {
    mockDbRaw(() => Promise.reject(new Error('simulated db outage')));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.db).toBe('unreachable');
  });
});
