/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {},
  // Refuses to run the suite at all unless PGDATABASE is the known-safe
  // test database — see tests/helpers/assertTestDatabase.js for why this
  // exists (a real incident, not a hypothetical).
  globalSetup: '<rootDir>/tests/helpers/assertTestDatabase.js',
};
