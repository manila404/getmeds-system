'use strict';

/**
 * The database handle, now backed by PostgreSQL.
 *
 * Sep 2, 2026. This file used to open `data/getmeds.db` with better-sqlite3 and
 * export a connected instance. It is now a one-line re-export of src/db/pg.js.
 *
 * Keeping the filename is deliberate: 24 files do
 * `const db = require('../db/database')`, and none of them had to change. The
 * port's diff is 507 edits of `await` and `async` — the thing being reviewed —
 * rather than 507 edits plus 24 unrelated import churn lines.
 *
 * The previous implementation is preserved as database.sqlite.js. It is not
 * loaded by anything; it is kept because it documents the auto-migrations that
 * used to run at require() time (is_test_account, zoho_item_id, zoho_contact_id,
 * source, last_synced_at and the customers zoho_contact_id unique index). Those
 * are all present in schema.pg.sql, so they now happen when the schema is
 * applied rather than on every boot.
 *
 * ONE BEHAVIOURAL DIFFERENCE, and it needs a line in server.js:
 *
 *   The old module exported an ALREADY-CONNECTED database, because SQLite opens
 *   a file synchronously. A network database cannot do that. `db.init()` must
 *   be awaited once before the first query:
 *
 *       const db = require('./src/db/database');
 *       await db.init();
 *       app.listen(PORT);
 *
 *   Skipping it does not fail silently — the first query throws a clear error —
 *   but it fails at request time rather than at boot, which is the worse place.
 */

module.exports = require('./pg');
