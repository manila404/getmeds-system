const fs = require('fs');
const path = require('path');
const db = require('./database');

// Adds `column` to `table` only if it doesn't already exist. schema.sql's
// `CREATE TABLE IF NOT EXISTS` is a no-op once a table already exists, so a
// brand-new column added to schema.sql never reaches a database that was
// migrated before that column was added — this is the only safe way to
// grow an existing table's shape. It only ever ADDs a column (never drops,
// renames, or rewrites one), so it's safe to run repeatedly and safe to run
// against a database that already has real orders/customers in it.
function ensureColumn(table, column, ddlType) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  // Aug 27, 2026: order-intake fields (see schema.sql's `orders` table
  // comment) — added here too so an already-migrated database (e.g. the
  // one already holding real synced Zoho customers/orders) picks them up
  // without needing to be recreated from scratch.
  ensureColumn('orders', 'intake_courier', 'TEXT');
  ensureColumn('orders', 'intake_doctor', 'TEXT');
  ensureColumn('orders', 'intake_hospital', 'TEXT');
  ensureColumn('orders', 'intake_patient', 'TEXT');
  ensureColumn('orders', 'intake_mop', 'TEXT');
  ensureColumn('orders', 'intake_receiver', 'TEXT');
  ensureColumn('orders', 'intake_contact_no', 'TEXT');
  ensureColumn('orders', 'intake_source', 'TEXT');
  ensureColumn('orders', 'intake_pls_give', 'TEXT');

  // Aug 27, 2026: Clients Directory feature — purely local classification
  // tag on customers (doctor/hospital/distributor/pwd), kept strictly
  // separate from `type` (credit/direct), which continues to drive payment
  // workflow routing unchanged. Never read from or written to Zoho.
  ensureColumn(
    'customers',
    'category',
    "TEXT CHECK(category IS NULL OR category IN ('doctor','hospital','distributor','pwd'))"
  );

  // Aug 27, 2026 (2): local snapshot of Zoho's last-known stock/price per
  // product, so the Inventory status page can compare against it without
  // making a live Zoho call on every page view/auto-refresh — see
  // schema.sql's `products` table comment.
  ensureColumn('products', 'zoho_stock', 'REAL');
  ensureColumn('products', 'zoho_price', 'REAL');

  console.log('✅ Migration completed successfully.');
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
