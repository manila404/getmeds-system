'use strict';

/**
 * Per-test-file database lifecycle.
 *
 * Sep 3, 2026. Two things the SQLite suite never needed:
 *
 * 1. `db.init()` must be awaited before the first query. The old data layer
 *    exported an already-connected handle because opening a file is
 *    synchronous; a pool is not.
 *
 * 2. The pool must be closed, or jest hangs. Each test file gets a fresh module
 *    registry and therefore its own pool; an open pool is an open handle and
 *    jest waits for it. The symptom is a suite that passes every assertion and
 *    then never exits, which reads like a deadlock rather than a missing
 *    teardown. Closing here rather than passing --forceExit means a genuine
 *    leak still shows up as one.
 */

const db = require('../src/db/database');

beforeAll(async () => {
  await db.init();
});

afterAll(async () => {
  await db.close();
});
