require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (!db) {
    const dbDir = path.join(__dirname, '../../data');
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

      migrateOrdersInvoiceDrafted(db);
    } catch (e) {
      console.warn('Note on DB migration:', e.message);
    }
  }
  return db;
}

// Adds the 'invoice_drafted' order status (Finance converted the Sales
// Order to an Invoice in Zoho, payment not yet recorded) plus the
// zoho_invoice_id / zoho_invoice_number columns that go with it.
//
// The two columns are a plain ALTER TABLE ADD COLUMN — safe on an existing
// table. The status value is a different story: it lives inside a CHECK
// constraint baked into the table's original CREATE TABLE statement, and
// SQLite has no ALTER TABLE ... ALTER CHECK. The only way to widen it on a
// database that was already created with the old constraint is the
// standard SQLite "rebuild" recipe — create a new table with the wider
// CHECK, copy every row across, drop the old table, rename the new one into
// place. Existing `id` values are preserved, so every foreign key in
// order_items/payments/dispatch_records/order_events/notifications/
// zoho_sync_queue still points at the right row afterwards.
function migrateOrdersInvoiceDrafted(db) {
  const ordersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (!ordersTable) return; // fresh install — schema.sql already has the new definition

  const cols = db.pragma('table_info(orders)').map(c => c.name);
  const needsColumns = !cols.includes('zoho_invoice_id') || !cols.includes('zoho_invoice_number');
  const needsCheckRebuild = !ordersTable.sql.includes('invoice_drafted');

  if (needsColumns) {
    if (!cols.includes('zoho_invoice_id')) db.exec('ALTER TABLE orders ADD COLUMN zoho_invoice_id TEXT');
    if (!cols.includes('zoho_invoice_number')) db.exec('ALTER TABLE orders ADD COLUMN zoho_invoice_number TEXT');
  }

  if (!needsCheckRebuild) return;

  console.log('[DB_MIGRATION] Rebuilding orders table to allow the invoice_drafted status...');

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        getmeds_order_id TEXT UNIQUE NOT NULL,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        medrep_id INTEGER NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
          'draft', 'submitted', 'validating', 'so_pending', 'so_created',
          'waiting_for_payment', 'invoice_drafted', 'payment_verified', 'ready_for_dispatch',
          'picking_packing', 'dispatched', 'tracking_shared', 'completed',
          'on_hold', 'exception', 'cancelled'
        )),
        customer_type TEXT NOT NULL CHECK(customer_type IN ('credit','direct')),
        total_amount REAL DEFAULT 0 CHECK(total_amount >= 0),
        delivery_address TEXT NOT NULL,
        delivery_notes TEXT,
        zoho_so_id TEXT,
        zoho_so_number TEXT,
        zoho_invoice_id TEXT,
        zoho_invoice_number TEXT,
        zoho_sync_status TEXT DEFAULT 'pending' CHECK(zoho_sync_status IN ('pending','synced','failed','skipped')),
        exception_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        submitted_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      INSERT INTO orders_new (
        id, getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, delivery_notes, zoho_so_id, zoho_so_number, zoho_invoice_id, zoho_invoice_number,
        zoho_sync_status, exception_reason, created_at, submitted_at, updated_at
      )
      SELECT
        id, getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, delivery_notes, zoho_so_id, zoho_so_number, zoho_invoice_id, zoho_invoice_number,
        zoho_sync_status, exception_reason, created_at, submitted_at, updated_at
      FROM orders;
    `);

    db.exec('DROP TABLE orders;');
    db.exec('ALTER TABLE orders_new RENAME TO orders;');

    // Recreate the indexes dropped along with the old table.
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_medrep_created ON orders(medrep_id, created_at DESC);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_submitted ON orders(status, submitted_at ASC);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);');
  });

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF'); // required while a referenced table is dropped/renamed
  try {
    rebuild();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  console.log('[DB_MIGRATION] orders table rebuilt — invoice_drafted status is now allowed.');
}

module.exports = getDb();
