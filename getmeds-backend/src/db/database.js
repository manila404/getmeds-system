require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (!db) {
    // Sep 1, 2026: GETMEDS_DB_DIR lets a throwaway database be pointed at a
    // temp directory. Added so tests/statusMigration.test.js can exercise the
    // orders-table rebuild in migrate.js against a realistic OLD-schema
    // database WITHOUT going anywhere near data/getmeds.db, which on a
    // working machine holds real synced Zoho customers and live test orders.
    // Unset — which is always the case for the server itself — behaves
    // exactly as before.
    const dbDir = process.env.GETMEDS_DB_DIR
      ? path.resolve(process.env.GETMEDS_DB_DIR)
      : path.join(__dirname, '../../data');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    db = new Database(path.join(dbDir, 'getmeds.db'));

    // WAL mode needs proper mmap/shared-memory + file-locking support from the
    // underlying filesystem. It fails with "SQLITE_IOERR" on some network
    // drives, synced folders (OneDrive/Dropbox), and virtualized mounts.
    // Fall back to the universally-compatible rollback journal if WAL isn't
    // supported here.
    try {
      db.pragma('journal_mode = WAL');
    } catch (e) {
      console.warn('journal_mode=WAL unavailable on this filesystem, falling back to DELETE:', e.message);
      try {
        db.pragma('journal_mode = DELETE');
      } catch (e2) {
        console.warn('Note on journal_mode pragma:', e2.message);
      }
    }

    try {
      db.pragma('foreign_keys = ON');
    } catch (e) {
      console.warn('Note on foreign_keys pragma:', e.message);
    }

    // Auto-migrate is_test_account column if table exists
    try {
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (tableExists) {
        const columns = db.pragma('table_info(users)').map(c => c.name);
        if (!columns.includes('is_test_account')) {
          db.exec('ALTER TABLE users ADD COLUMN is_test_account INTEGER DEFAULT 0');
        }
      }

      const prodTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
      if (prodTableExists) {
        const prodCols = db.pragma('table_info(products)').map(c => c.name);
        if (!prodCols.includes('zoho_item_id')) {
          db.exec('ALTER TABLE products ADD COLUMN zoho_item_id TEXT');
        }
        if (!prodCols.includes('last_synced_at')) {
          db.exec('ALTER TABLE products ADD COLUMN last_synced_at TEXT');
        }
      }

      // Auto-migrate customers.zoho_contact_id / source / last_synced_at —
      // added Aug 27, 2026 so a customer pulled from Zoho (read-only, see
      // customers.controller.js) can be mapped to an existing Zoho contact
      // id for order creation, without ever writing a contact to Zoho.
      const custTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'").get();
      if (custTableExists) {
        const custCols = db.pragma('table_info(customers)').map(c => c.name);
        if (!custCols.includes('zoho_contact_id')) {
          db.exec('ALTER TABLE customers ADD COLUMN zoho_contact_id TEXT');
        }
        if (!custCols.includes('source')) {
          db.exec("ALTER TABLE customers ADD COLUMN source TEXT DEFAULT 'local'");
        }
        if (!custCols.includes('last_synced_at')) {
          db.exec('ALTER TABLE customers ADD COLUMN last_synced_at TEXT');
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_zoho_contact_id ON customers(zoho_contact_id) WHERE zoho_contact_id IS NOT NULL');
      }

      warnIfOrderStatusesBehind(db);
    } catch (e) {
      console.warn('Note on DB migration:', e.message);
    }
  }
  return db;
}

/**
 * Read-only check: does `orders`' status CHECK constraint still allow every
 * status this build can write?
 *
 * Sep 1, 2026 (2). This replaces migrateOrdersInvoiceDrafted(), which used to
 * rebuild the orders table from a CREATE TABLE statement hard-coded in this
 * file. That was a live hazard: its hard-coded definition had not been
 * updated since Aug, so it was missing the status values added since AND
 * eleven real columns (every intake_*, sales_order_date, intake_terms,
 * intake_payment_terms, invoicing_from, zoho_so_status). It could not fire on
 * a current database — its guard was "does the DDL mention invoice_drafted",
 * which every current database does — but had it ever fired, on a restored
 * backup or an older copy, it would have silently dropped those columns and
 * their data with no error.
 *
 * Schema changes now belong to src/db/migrate.js alone, which rebuilds from
 * schema.sql (the actual source of truth) and is covered by
 * tests/statusMigration.test.js. All that is left here is a warning, so a
 * server started without migrating says so in plain language instead of
 * failing later with a bare SQLite constraint error on the first webhook.
 */
function warnIfOrderStatusesBehind(db) {
  const ordersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (!ordersTable || !ordersTable.sql) return;

  const ddl = ordersTable.sql.replace(/--[^\n]*/g, ''); // comments quote status names too
  const required = [
'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'ready_for_finance_verified', 'ready_for_draft_invoice',
    'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'
  ];
  const missing = required.filter((s) => !ddl.includes(`'${s}'`));
  if (!missing.length) return;

  console.warn(
    `\n⚠️  This database's orders table does not allow these statuses yet: ${missing.join(', ')}.\n` +
      '   Zoho events that need them will fail with a CHECK constraint error.\n' +
      '   Fix: stop the server and run  npm run migrate\n'
  );
}

module.exports = getDb();
