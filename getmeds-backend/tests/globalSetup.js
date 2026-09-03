const path = require('path');
const { Client } = require('pg');
const { execFileSync } = require('child_process');

/**
 * Builds the throwaway PostgreSQL database the whole suite runs against, once,
 * before any test file is loaded.
 *
 * Sep 3, 2026. Replaces the better-sqlite3 version. The reasoning in the old
 * file still holds and is worth restating, because the hazard is worse here,
 * not better:
 *
 *   Until Sep 2 the suite ran against the REAL database. customersSync.test.js
 *   opens with `DELETE FROM customers WHERE source = 'zoho'`, which against
 *   that database is an attempt to delete the entire 95k-row Zoho mirror. It
 *   failed only because a foreign key from an existing order refused it —
 *   luck, not a safeguard.
 *
 * With a hosted database that mistake is no longer recoverable by deleting a
 * local file. So this script does not merely prefer a scratch database, it
 * REFUSES to run against anything that looks like a real one, and it drops and
 * recreates the database it does use.
 *
 * TEST_DATABASE_URL selects the target. The default is a local PostgreSQL,
 * because running the suite against a hosted Supabase project would turn a
 * 13-second run into minutes of network round trips — and a suite people stop
 * running is worse than a slow one.
 */

const BACKEND = path.join(__dirname, '..');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/getmeds_test';

/**
 * Refuse to touch anything that is not obviously a scratch database.
 *
 * This runs immediately before a DROP DATABASE, so being noisy and wrong is
 * cheap and being quiet and wrong is not.
 */
function assertScratchDatabase(url) {
  const dbName = (url.split('/').pop() || '').split('?')[0];
  const looksLikeTest = /(^|_)test($|_)|scratch/i.test(dbName);
  const looksHosted = /supabase\.co|neon\.tech|pooler\.|render\.com|amazonaws\.com/i.test(url);

  if (looksHosted) {
    throw new Error(
      `tests/globalSetup.js refuses to run against a hosted database.\n` +
        `  TEST_DATABASE_URL points at: ${url.replace(/:[^:@/]*@/, ':****@')}\n` +
        `  This script DROPS AND RECREATES the database it is given.`
    );
  }
  if (!looksLikeTest) {
    throw new Error(
      `tests/globalSetup.js refuses to run against database "${dbName}".\n` +
        `  The name must contain "test" or "scratch" — this script drops it.`
    );
  }
}

/** Connect to the maintenance database, so the test database can be dropped. */
function adminUrl(url) {
  return url.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
}

module.exports = async () => {
  assertScratchDatabase(TEST_URL);

  const dbName = (TEST_URL.split('/').pop() || '').split('?')[0];
  const admin = new Client({ connectionString: adminUrl(TEST_URL) });
  await admin.connect();
  try {
    // FORCE disconnects any client left over from a previous run. Without it a
    // crashed run leaves a connection open, DROP DATABASE blocks indefinitely,
    // and it looks exactly like a hung test suite.
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  // migrate and seed run as CHILD PROCESSES, as they did before: src/db/pg.js
  // memoises one pool per process, and the seed script's connection should not
  // be the one the suite then inherits.
  const env = { ...process.env, DATABASE_URL: TEST_URL, NODE_ENV: 'test', ZOHO_MODE: 'mock' };
  for (const script of ['src/db/migrate.pg.js', 'src/db/seed.js']) {
    try {
      execFileSync(process.execPath, [path.join(BACKEND, script)], {
        cwd: BACKEND,
        env,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      throw new Error(`tests/globalSetup.js: ${script} failed while building the test database.\n${detail}`);
    }
  }

  await seedBaselineFixtures(TEST_URL);
};

/**
 * The one customer and two products that six suites assume already exist.
 *
 * Carried over in intent from the SQLite version; the reasoning has not
 * changed. Until Sep 2 seed.js created five demo customers and ten demo
 * products, and these suites quietly relied on them — customersSync,
 * inventorySync, orderIntakeFields, zohoAutoSync, orderOpenResilience and
 * webhook all open with some flavour of `SELECT ... LIMIT 1` and never check
 * the result. Once seed.js stopped inventing that data (rightly: a hand-written
 * customer has no zoho_contact_id, so an order raised against it can never
 * reach Zoho) those lookups returned undefined.
 *
 * This is deliberately NOT a restoration of demo data to seed.js. It is the
 * test suite's own fixture floor, as small as the assertions allow:
 *
 *   - `type = 'direct'`      zohoAutoSync and webhook both select on it
 *   - `source = 'local'`     customersSync needs a customer its
 *                            `DELETE ... WHERE source = 'zoho'` will not take
 *   - `zoho_contact_id` set  order creation refuses a customer without one
 *   - `is_active = 1`        orderIntakeFields and customersSync filter on it
 *
 * No zoho_item_id on the products, on purpose: inventorySync asserts against
 * products that sync-pull created, selecting WHERE zoho_item_id IS NOT NULL,
 * and a fixture carrying one would be picked up instead.
 *
 * New tests should create their own fixtures rather than adding to this. A
 * suite that silently depends on ambient rows is the exact failure mode this
 * comment exists to describe.
 */
async function seedBaselineFixtures(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number, address,
                              is_active, zoho_contact_id, source)
       VALUES ('FIXTURE Direct Customer', 'direct', 0, 'Fixture Contact', '09170000000',
               '1 Fixture St, Manila', 1, 'FIXTURE-CONTACT-1', 'local')`
    );
    await c.query(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES
         ('FIXTURE Paracetamol 500mg', 'FIX-PARA-500', 12.5, 'tab', 100, 1),
         ('FIXTURE Amoxicillin 250mg', 'FIX-AMOX-250', 25.0, 'cap', 80, 1)`
    );
  } finally {
    await c.end();
  }
}
