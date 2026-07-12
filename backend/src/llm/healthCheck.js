import { config } from '../config.js';
import { getEffectiveSettings } from './settingsService.js';
import { getAdapter } from './adapterFactory.js';

// PROJECT_PLAN.md Section 2: "On startup and periodically thereafter, the
// backend health-checks the configured provider and surfaces reachability
// (up/down, last check time) through the admin settings surface, so a
// misconfigured or unreachable provider is visibly diagnosable rather than a
// silent failure the first time someone clicks 'Summarize.'" In-process
// state, read fresh by the settings route on every request — same
// single-instance basis as presence/rate-limiting elsewhere in this app.
let status = { healthy: false, message: 'not checked yet', provider: config.llm.provider, lastCheckedAt: null };
let sweepTimer = null;

export async function runHealthCheck(db) {
  const settings = await getEffectiveSettings(db);
  const adapter = getAdapter(settings.provider);
  const result = await adapter.checkHealth({ settings: { ...settings, apiKey: config.llm.apiKey } });
  status = {
    healthy: result.healthy,
    message: result.message,
    provider: settings.provider,
    lastCheckedAt: new Date().toISOString(),
  };
  return status;
}

export function getHealthStatus() {
  return status;
}

export function startHealthSweep(db) {
  if (sweepTimer) return sweepTimer;
  // Fire once immediately (startup check), then on the configured interval.
  runHealthCheck(db).catch(() => {});
  sweepTimer = setInterval(() => {
    runHealthCheck(db).catch(() => {});
  }, config.llm.healthCheckIntervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopHealthSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function _resetForTests() {
  status = { healthy: false, message: 'not checked yet', provider: config.llm.provider, lastCheckedAt: null };
  stopHealthSweep();
}
