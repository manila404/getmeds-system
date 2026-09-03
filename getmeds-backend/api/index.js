'use strict';

/**
 * Vercel serverless entry point.
 *
 * Sep 3, 2026. Vercel does not run server.js and never calls app.listen(); it
 * imports this file and hands each request to the exported handler. Two things
 * that were free with a long-lived process have to be arranged explicitly here.
 *
 * 1. THE DATABASE CONNECTION IS ASYNC AND MUST BE READY BEFORE THE FIRST QUERY.
 *
 *    The old data layer exported an already-connected better-sqlite3 handle,
 *    because opening a file is synchronous. A network database cannot do that,
 *    so src/db/pg.js has an init() that must be awaited once. There is nowhere
 *    to await it at module scope in CommonJS, so it is awaited in a middleware
 *    that runs before every request.
 *
 *    The promise is memoised, NOT the boolean. Memoising a boolean means N
 *    concurrent cold-start requests all see `false` and all call init(), which
 *    on a free-tier connection limit is how a cold start turns into a burst of
 *    connection failures. Memoising the promise makes them all await the same
 *    one.
 *
 *    A FAILED init is deliberately not cached. If the first request arrives
 *    while the database is briefly unreachable — a Supabase free project waking
 *    from its 7-day pause, say — caching that rejection would poison the
 *    instance for its whole lifetime and every later request would fail against
 *    a database that had since come back.
 *
 * 2. THE APP IS WRAPPED, NOT MODIFIED.
 *
 *    An outer Express app runs the init middleware and then mounts src/app.js
 *    unchanged, so nothing about the app differs between local and serverless.
 */

require('dotenv').config();
const express = require('express');
const app = require('../src/app');
const db = require('../src/db/database');

let initPromise = null;

function ensureReady() {
  if (!initPromise) {
    initPromise = db.init().catch((err) => {
      initPromise = null; // let the next request try again
      throw err;
    });
  }
  return initPromise;
}

const handler = express();

handler.use(async (req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (err) {
    // A clear 503 rather than a stack trace: at this point the app is fine and
    // the database is not, and that distinction is what someone reading the
    // logs at 2am needs.
    console.error('[api] database init failed:', err.message);
    res.status(503).json({
      success: false,
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'The database is not reachable. If this is a free-tier project it may be resuming.',
      },
    });
  }
});

handler.use(app);

module.exports = handler;
