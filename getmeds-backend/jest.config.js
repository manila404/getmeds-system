module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  // Builds data/test-db/getmeds.db once, before any test file loads, so the
  // suite never opens the real data/getmeds.db. See tests/setupEnv.js.
  globalSetup: '<rootDir>/tests/globalSetup.js',
  // One shared SQLite file plus parallel workers means SQLITE_BUSY and
  // fixtures from different suites colliding. The whole suite runs in about
  // ten seconds, so serial is cheap insurance. Safe to remove if the runtime
  // ever starts to matter more than the determinism.
  maxWorkers: 1
};
