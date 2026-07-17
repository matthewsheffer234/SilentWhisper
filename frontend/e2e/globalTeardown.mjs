import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, '..', '..', 'scripts');

// Operator's standing instruction: "all test artifacts should be cleaned
// from the database after tests are run; preserve logs always." Runs
// scripts/clear-test-artifacts.mjs as a subprocess rather than importing it
// directly — that script is deliberately its own tiny package (own
// node_modules, same reasoning as every other tool in scripts/), so
// spawning it from its own directory sidesteps needing its dependencies to
// resolve from frontend/node_modules.
//
// Logs and continues rather than throwing on failure: a cleanup hiccup
// shouldn't retroactively mark an otherwise-green test run as failed. Rerun
// `npm run clear-test-artifacts` in scripts/ by hand if this warns.
export default function globalTeardown() {
  console.log('\n[globalTeardown] Clearing e2e test artifacts from the dev database...');
  const result = spawnSync('node', ['clear-test-artifacts.mjs'], { cwd: scriptsDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(
      '[globalTeardown] clear-test-artifacts.mjs failed (exit code',
      result.status,
      ') — test artifacts may remain in the dev database. Run `npm run clear-test-artifacts` in scripts/ manually to retry.',
    );
  }
}
