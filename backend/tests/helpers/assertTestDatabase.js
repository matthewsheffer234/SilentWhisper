// jest.config.js's globalSetup: runs once, in its own process, before any
// test file is even loaded — independent of whether a given test file
// imports resetDb.js at all (a small number, e.g. health.test.js, touch
// `db` directly without ever importing it). Defense-in-depth alongside
// resetDb.js's own module-load-time guard: that one catches PGDATABASE
// having already fallen through to backend/.env's real value (via dotenv,
// once some test file's own import chain triggers it); this one runs
// before dotenv has loaded at all, so a genuinely missing
// `PGDATABASE=silent_whisper_test` prefix shows up here as `undefined` and
// gets refused immediately, before any test file's own fallback resolution
// even has a chance to run.
//
// Real incident, not a hypothetical: on 2026-07-20 a bare `node ... jest ...`
// invocation (skipping the prefix `npm test` normally bakes in) silently
// wiped the live production database via resetDb()'s beforeEach. A single
// comment-only warning wasn't enough to prevent that from happening twice.
const EXPECTED_TEST_DATABASE = 'silent_whisper_test';

export default async function globalSetup() {
  if (process.env.PGDATABASE !== EXPECTED_TEST_DATABASE) {
    throw new Error(
      `Refusing to run the backend test suite: PGDATABASE is "${process.env.PGDATABASE}", not "${EXPECTED_TEST_DATABASE}". ` +
        'This suite includes tests that unconditionally delete data (tests/helpers/resetDb.js). ' +
        'Always run tests via "npm test" (package.json bakes in the correct PGDATABASE) — never a bare `node ...jest` invocation.',
    );
  }
}
