module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  // Opens the connection pool before each file's tests and closes it after.
  // Without the close, jest passes every assertion and then hangs on the open
  // handle. See tests/setupAfterEnv.js.
  setupFilesAfterEnv: ['<rootDir>/tests/setupAfterEnv.js'],
  // Drops, recreates and migrates the scratch PostgreSQL database once, before
  // any test file loads, so the suite never touches the real one. See
  // tests/setupEnv.js and tests/globalSetup.js.
  globalSetup: '<rootDir>/tests/globalSetup.js',
  // One shared database plus parallel workers means fixtures from different
  // suites colliding — the same reason as under SQLite, minus SQLITE_BUSY.
  // Serial is cheap insurance. Safe to revisit only by giving each worker its
  // own database, not by simply raising this number.
  maxWorkers: 1,
  // The verify harnesses are run by hand (npm run verify:pg), not by jest:
  // they truncate every table.
  testPathIgnorePatterns: ['/node_modules/', '\\.verify\\.js$']
};
