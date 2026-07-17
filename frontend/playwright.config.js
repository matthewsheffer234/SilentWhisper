import { defineConfig } from '@playwright/test';

// PROJECT_PLAN.md Section 8, Phase 5: "Add integration tests for key user
// workflows." Deliberately does NOT use Playwright's `webServer` option to
// auto-start anything — these tests exercise the real stack end to end
// (frontend + backend + Postgres + a real Ollama instance for the AI
// workflows), which `docker compose up` already knows how to bring up
// correctly; re-deriving that orchestration here would just duplicate
// docker-compose.yml. Bring the stack up first (see RUNBOOK.md's Running
// Tests / Integration Tests section), then run `npm run test:e2e`.
export default defineConfig({
  testDir: './e2e',
  // Operator's standing instruction: test artifacts get swept from the dev
  // database after every run (scripts/clear-test-artifacts.mjs), never the
  // audit log. Runs once after the whole suite, pass or fail — see
  // e2e/globalTeardown.mjs.
  globalTeardown: './e2e/globalTeardown.mjs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    // Defaults to the public domain, not bare localhost:3101, because this
    // environment's frontend image is built with VITE_API_URL/VITE_WS_URL
    // baked in at build time (Vite env vars aren't runtime-configurable) —
    // see docker-compose.yml / RUNBOOK.md's Production Deployment section.
    // If that's pointed at https://whisper.silentlattice.dev (the normal
    // case here), running these tests against http://localhost:3101 instead
    // makes every API call cross-origin, and the refresh-token cookie is
    // SameSite=Strict (Section 3, Authentication & Session Security) — a
    // cross-site request simply never sends it, so the session-restore-on-
    // reload workflow fails in a way that has nothing to do with the app
    // being broken. Override with E2E_BASE_URL if the frontend was instead
    // built pointing at a same-origin localhost backend.
    baseURL: process.env.E2E_BASE_URL || 'https://whisper.silentlattice.dev',
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
});
