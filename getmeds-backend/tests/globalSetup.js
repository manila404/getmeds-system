const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

/**
 * Builds the throwaway database the whole suite runs against, once, before any
 * test file is loaded. tests/setupEnv.js explains why it must not be the real
 * one; this is the half that creates the replacement.
 *
 * migrate.js and seed.js run as CHILD PROCESSES with GETMEDS_DB_DIR set.
 * src/db/database.js exports a singleton opened on first require, so an
 * already-loaded module cannot be repointed at a different file in-process —
 * tests/statusMigration.test.js shells out for exactly the same reason.
 *
 * The directory is deleted and rebuilt on every run, so a schema change can
 * never leave a stale test database behind to produce a confusing failure. It
 * lives under data/, which .gitignore already covers.
 *
 * Worth knowing what a freshly seeded database does NOT contain: customers and
 * products. seed.js stopped inventing them on Sep 2 — they belong to the
 * read-only Zoho mirror now — so a test needing either has to create its own
 * fixture or pull from the mock adapter.
 */
const BACKEND = path.join(__dirname, '..');
const TEST_DB_DIR = path.join(BACKEND, 'data', 'test-db');

module.exports = () => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });

  const env = {
    ...process.env,
    GETMEDS_DB_DIR: TEST_DB_DIR,
    NODE_ENV: 'test',
    ZOHO_MODE: 'mock'
  };

  for (const script of ['src/db/migrate.js', 'src/db/seed.js']) {
    try {
      execFileSync(process.execPath, [path.join(BACKEND, script)], {
        cwd: BACKEND,
        env,
        stdio: 'pipe',
        encoding: 'utf8'
      });
    } catch (err) {
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      throw new Error(
        `tests/globalSetup.js: ${script} failed while building the test database.\n${detail}`
      );
    }
  }

  seedBaselineFixtures();
};

/**
 * The one customer and two products that six suites assume already exist.
 *
 * Until Sep 2 seed.js created five demo customers and ten demo products, and
 * these suites quietly relied on them — customersSync, inventorySync,
 * orderIntakeFields, zohoAutoSync, orderOpenResilience and webhook all open
 * with some flavour of `SELECT ... FROM customers/products LIMIT 1` and never
 * check the result. Once seed.js stopped inventing that data (rightly: a
 * hand-written customer has no zoho_contact_id, so an order raised against it
 * can never reach Zoho) those lookups returned undefined. On a developer
 * machine that stayed hidden, because the suite was running against the real
 * database and helping itself to the 95k-row Zoho mirror.
 *
 * So this is deliberately NOT a restoration of demo data to seed.js — the
 * product decision there stands, and the real database should keep getting
 * customers and products from the Zoho mirror alone. It is the test suite's
 * own fixture floor, and it is as small as the assertions allow:
 *
 *   - `type = 'direct'`      zohoAutoSync and webhook both select on it
 *   - `source = 'local'`     customersSync needs a customer its
 *                            `DELETE ... WHERE source = 'zoho'` will not take
 *   - `zoho_contact_id` set  order creation refuses a customer without one
 *   - `is_active = 1`        orderIntakeFields and customersSync filter on it
 *
 * New tests should create their own fixtures rather than adding to this. A
 * suite that silently depends on ambient rows is the exact failure mode this
 * comment exists to describe.
 */
function seedBaselineFixtures() {
  const db = new Database(path.join(TEST_DB_DIR, 'getmeds.db'));
  try {
    db.prepare(
      `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number, address,
                              is_active, zoho_contact_id, source)
       VALUES ('FIXTURE Direct Customer', 'direct', 0, 'Fixture Contact', '09170000000',
               '1 Fixture St, Manila', 1, 'FIXTURE-CONTACT-1', 'local')`
    ).run();

    const insertProduct = db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, ?, ?, ?, ?, 1)`
    );
    // No zoho_item_id on purpose: inventorySync asserts against products that
    // sync-pull created, selecting them WHERE zoho_item_id IS NOT NULL, and a
    // fixture carrying one would get picked up instead.
    insertProduct.run('FIXTURE Paracetamol 500mg', 'FIX-PARA-500', 12.5, 'tab', 100);
    insertProduct.run('FIXTURE Amoxicillin 250mg', 'FIX-AMOX-250', 25.0, 'cap', 80);
  } finally {
    db.close();
  }
}
