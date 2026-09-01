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

/**
 * Widen `orders.status`'s CHECK constraint to whatever schema.sql now says.
 *
 * Sep 1, 2026, added for the new 'ready_for_dispatch' status. ensureColumn() above
 * can only ever ADD a column — it is no help here, because SQLite has no
 * "ALTER TABLE ... ALTER CONSTRAINT". On a database that was migrated before
 * a status was added, the old CHECK is still in force and every write of the
 * new value fails with a constraint error, even though schema.sql looks
 * correct. The only way through is to rebuild the table.
 *
 * The rebuild leans on schema.sql being the complete, current definition of
 * `orders` (it is — every column ensureColumn() adds below is also declared
 * there), so renaming the live table out of the way and re-running the schema
 * recreates it in the right shape, indexes included. Rows are copied back on
 * the intersection of old and new columns, so a column that only exists on
 * one side can't break the copy.
 *
 * Two pragmas matter here and are easy to get wrong:
 *  - foreign_keys OFF, or the rename/drop trips other tables' references.
 *  - legacy_alter_table ON, because since SQLite 3.25 ALTER TABLE RENAME also
 *    rewrites references to that table in OTHER tables' schemas. Without it,
 *    order_items/payments/dispatch_records/order_events would all quietly end
 *    up pointing at `orders_legacy_status` and follow it into the DROP.
 * Both are restored afterwards. No-ops entirely once the constraint is
 * current, so this is safe to run on every startup.
 */
function ensureOrderStatusValues(schema) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (!existing || !existing.sql) return;

  // SQLite stores the CREATE TABLE statement verbatim, comments included —
  // and schema.sql's comments mention the status names in quotes. Strip
  // `-- ...` lines before deciding, or a comment saying a status was added
  // would count as the status actually being in the CHECK list.
  const ddl = existing.sql.replace(/--[^\n]*/g, '');

  // Sep 1, 2026 (2): driven off a list rather than a single hard-coded
  // status. The first version of this checked only for 'ready_for_dispatch', which
  // meant the very next status added ('deleted', the same day) would have
  // been silently skipped on any database already rebuilt once — the check
  // would pass, no rebuild would run, and every write of the new status
  // would fail with a constraint error at runtime instead. Compare against
  // everything the app can write and this stops being a per-status edit.
  const REQUIRED_STATUSES = [
'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'ready_for_finance_verified', 'ready_for_draft_invoice',
    'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'
  ];
  const missing = REQUIRED_STATUSES.filter((s) => !ddl.includes(`'${s}'`));
  if (!missing.length) return; // already current

  console.log(`↻ Rebuilding \`orders\` to widen its status CHECK constraint (adds: ${missing.join(', ')})…`);

  const oldColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec('ALTER TABLE orders RENAME TO orders_legacy_status');
      // Recreates `orders` (and re-creates its indexes) from the current
      // schema. Every other CREATE ... IF NOT EXISTS in the file is a no-op.
      db.exec(schema);

      const newColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
      const shared = oldColumns.filter((c) => newColumns.includes(c));
      const columnList = shared.map((c) => `"${c}"`).join(', ');

      // Sep 1, 2026 (5): the copy also RENAMES retired statuses on the way
      // across. Doing it here rather than as a follow-up UPDATE matters —
      // the new CHECK constraint doesn't allow the old values, so there is
      // no moment at which a plain copy followed by an update could work.
      //
      // Every WHEN reads the OLD table, so they all see original values and
      // the order of the clauses can't cascade. That is the subtle part:
      // 'invoice_sent' maps TO 'ready_for_dispatch', while rows already AT
      // 'ready_for_dispatch' mean something else entirely and map away from
      // it. Run as sequential UPDATEs these two would collide and the
      // just-migrated invoice_sent rows would be re-migrated as if they were
      // legacy ones.
      //
      // Old ready_for_dispatch meant "Sales Order confirmed, go pack" — no
      // invoice involved. Under the new naming that is ready_for_draft_invoice,
      // unless an invoice id is already on file, in which case the order had
      // genuinely been invoiced and belongs at ready_for_invoice_sent.
      const hasInvoiceId = shared.includes('zoho_invoice_id');
      const legacyReadyForDispatch = hasInvoiceId
        ? `WHEN status = 'ready_for_dispatch' AND zoho_invoice_id IS NOT NULL THEN 'ready_for_invoice_sent'
           WHEN status = 'ready_for_dispatch' THEN 'ready_for_draft_invoice'`
        : `WHEN status = 'ready_for_dispatch' THEN 'ready_for_draft_invoice'`;

      const statusExpr = `CASE
          ${legacyReadyForDispatch}
          WHEN status = 'waiting_for_payment' THEN 'ready_for_draft_invoice'
          WHEN status = 'invoice_drafted'     THEN 'ready_for_invoice_sent'
          WHEN status = 'invoice_sent'        THEN 'ready_for_dispatch'
          WHEN status = 'payment_verified'    THEN 'ready_for_dispatch'
          ELSE status
        END`;

      const selectList = shared.map((c) => (c === 'status' ? `${statusExpr} AS "status"` : `"${c}"`)).join(', ');

      db.exec(`INSERT INTO orders (${columnList}) SELECT ${selectList} FROM orders_legacy_status`);
      db.exec('DROP TABLE orders_legacy_status');

      // Re-run the schema a second time, AFTER the drop, purely to recreate
      // the indexes. Renaming a table takes its indexes with it — they keep
      // their original names (idx_orders_*) but now belong to
      // orders_legacy_status, so the CREATE INDEX IF NOT EXISTS statements in
      // the exec above saw those names already taken and did nothing, and
      // then DROP TABLE took the indexes with it. The result was a correctly
      // rebuilt `orders` table with zero indexes on it — no error, no
      // warning, just every order query going to a full scan on a table that
      // grows forever. Caught by asserting the index count in the migration
      // test rather than by anything failing.
      db.exec(schema);
    })();

    const dropped = oldColumns.filter(
      (c) => !db.prepare('PRAGMA table_info(orders)').all().map((x) => x.name).includes(c)
    );
    if (dropped.length) {
      console.warn(
        `⚠️  These columns existed on the old \`orders\` table but not in schema.sql, so they were not ` +
          `carried over: ${dropped.join(', ')}. Add them to schema.sql if they are still needed.`
      );
    }
    console.log('✅ `orders` rebuilt — status CHECK constraint is current.');
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
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

  // Sep 1, 2026 (3): when this order was last pulled from Zoho by the
  // reconcile (services/zohoReconcileService.js). Shared by the background
  // poller — which works oldest-first through it — and the refresh-on-open
  // throttle, so neither re-reads an order the other just did. NULL means
  // never reconciled, which sorts to the front of the queue.
  ensureColumn('orders', 'last_reconciled_at', 'TEXT');

  // Sep 1, 2026: run LAST, after every ensureColumn above — the rebuild
  // copies rows across on the intersection of the old and new column lists,
  // so the old table wants to be at its most complete before we do it.
  ensureOrderStatusValues(schema);

  console.log('✅ Migration completed successfully.');
}

if (require.main === module) {
  migrate();
}

module.exports = migrate;
