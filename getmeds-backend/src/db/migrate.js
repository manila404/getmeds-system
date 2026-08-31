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

  // Aug 30, 2026: "Create New Order" form redesign — new order-level fields
  // (see schema.sql's `orders` table comment and
  // ZOHO_SALES_ORDER_FIELD_MAPPING.md for what each maps to in Zoho).
  ensureColumn('orders', 'sales_order_date', 'TEXT');
  ensureColumn('orders', 'intake_delivery_method', 'TEXT');
  ensureColumn('orders', 'intake_terms', 'TEXT');
  ensureColumn(
    'orders',
    'invoicing_from',
    "TEXT CHECK(invoicing_from IS NULL OR invoicing_from IN ('2mg Incorporated', 'Getmeds Philippines Inc.'))"
  );

  // Aug 30, 2026 (2): Payment Terms — mirrors the same-named field on
  // Zoho's own Sales Order screen (Net 15 / 30 days / 45 Day / BPO WALLET /
  // 60 Day / DSWD/PCSO, or a custom typed value). Free text, not an enum —
  // Zoho's own field accepts a custom value too.
  ensureColumn('orders', 'intake_payment_terms', 'TEXT');

  // Same redesign — per-line Discount/Tax on order_items (see schema.sql's
  // `order_items` table comment). Defaulted so existing rows read as
  // line_total = subtotal (zero discount, zero tax), unchanged from before.
  ensureColumn('order_items', 'discount_amount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('order_items', 'tax_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('order_items', 'tax_label', 'TEXT');
  ensureColumn('order_items', 'line_total', 'REAL NOT NULL DEFAULT 0');

  // Aug 31, 2026: last-known Zoho-side Sales Order status, so the "edited in
  // Zoho" webhook handler can detect a real status transition (e.g. someone
  // clicked "Confirm" in Zoho) and log it distinctly from a field edit — see
  // schema.sql's `orders` table comment.
  ensureColumn('orders', 'zoho_so_status', 'TEXT');

  console.log('✅ Migration completed successfully.');
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
