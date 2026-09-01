const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

/**
 * Guards the orders-table rebuild in src/db/migrate.js.
 *
 * Sep 1, 2026, added with the new 'ready_for_dispatch' status. SQLite has no
 * "ALTER TABLE ... ALTER CONSTRAINT", so widening `orders.status`'s CHECK
 * list means renaming the table, recreating it from schema.sql, and copying
 * every row back. That is the single most destructive operation in this
 * codebase and it runs against a database holding real orders and thousands
 * of synced Zoho customers — so it gets a test that reproduces the real
 * situation rather than a fresh, empty database where the rebuild never even
 * triggers.
 *
 * Runs migrate.js in a CHILD PROCESS with GETMEDS_DB_DIR pointed at a temp
 * directory: the db module is a long-lived singleton, so this is the only way
 * to migrate a different database without touching data/getmeds.db.
 *
 * The index assertion below is not padding. The first version of the rebuild
 * passed every other check here and silently left `orders` with no indexes at
 * all — renaming a table takes its indexes with it, so the CREATE INDEX IF
 * NOT EXISTS statements found the names taken and did nothing, and the DROP
 * then took them away. No error, no warning, just full table scans forever.
 */
describe('orders status CHECK-constraint migration', () => {
  const BACKEND = path.join(__dirname, '..');
  let tmpDir;
  let dbPath;

  const openDb = () => new Database(dbPath);

  /** The orders table's DDL with `-- ...` comments removed. */
  const ordersCheckList = (db) =>
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'")
      .get()
      .sql.replace(/--[^\n]*/g, '');

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getmeds-migration-'));
    dbPath = path.join(tmpDir, 'getmeds.db');

    // A database on the OLD schema — schema.sql with invoice_sent removed
    // from the status CHECK, which is exactly what a machine migrated before
    // today has on disk.
    const currentSchema = fs.readFileSync(path.join(BACKEND, 'src/db/schema.sql'), 'utf8');
    // Strip it from the CHECK list only — schema.sql also mentions
    // 'ready_for_dispatch' in a comment, and a blanket replace would leave the
    // fixture looking old while the file's own comment still said otherwise.
    // Whitespace-agnostic on purpose: schema.sql is stored with CRLF line
    // endings, so a literal "…, 'deleted'\n" match silently does nothing and
    // the "old" fixture comes out identical to the current schema — which
    // makes the whole suite pass while testing nothing.
    const oldSchema = currentSchema
      .replace(/'ready_for_dispatch',\s*/, '')
      .replace(/,\s*'deleted'/, '');

    const db = openDb();
    db.pragma('foreign_keys = ON');
    db.exec(oldSchema);

    // Confirm the fixture is genuinely on the old constraint, read back from
    // SQLite itself rather than trusting the string edit above. Comments are
    // stripped first — SQLite stores the CREATE TABLE statement verbatim, so
    // schema.sql's own comment about the status would otherwise match.
    // Match the quoted token, not a bare substring — the orders DDL mentions
    // these words in other contexts too.
    expect(ordersCheckList(db)).not.toContain("'ready_for_dispatch'");
    expect(ordersCheckList(db)).not.toContain("'deleted'");

    db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Ana','ana@getmeds.ph','x','medrep')").run();
    db.prepare("INSERT INTO customers (name,type,zoho_contact_id) VALUES ('Real Client','credit','ZC-1')").run();
    db.prepare("INSERT INTO products (name,sku,unit_price) VALUES ('Amoxicillin','SKU-1',10)").run();
    db.prepare(
      `INSERT INTO orders (getmeds_order_id,customer_id,medrep_id,status,customer_type,total_amount,
                           delivery_address,zoho_so_id,zoho_so_number,intake_doctor,invoicing_from)
       VALUES ('GM-20260830-0001',1,1,'tracking_shared','credit',1500,'Manila','ZSO-1','SO-66824','Dr Cruz','Getmeds Philippines Inc.')`
    ).run();
    db.prepare('INSERT INTO order_items (order_id,product_id,quantity,unit_price,subtotal) VALUES (1,1,3,10,30)').run();
    db.prepare("INSERT INTO payments (order_id,status) VALUES (1,'pending')").run();
    db.prepare("INSERT INTO dispatch_records (order_id,status,tracking_number) VALUES (1,'dispatched','LBC-1')").run();
    db.prepare("INSERT INTO order_events (order_id,event_type,new_status) VALUES (1,'STATUS_CHANGE','tracking_shared')").run();
    db.close();
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the old schema really does reject the new status (fixture is valid)', () => {
    const db = openDb();
    expect(() => db.prepare("UPDATE orders SET status='ready_for_dispatch' WHERE id=1").run()).toThrow(/CHECK constraint/i);
    db.close();
  });

  test('migrating rebuilds the table without losing anything', () => {
    execFileSync(process.execPath, [path.join(BACKEND, 'src/db/migrate.js')], {
      cwd: BACKEND,
      env: { ...process.env, GETMEDS_DB_DIR: tmpDir },
      stdio: 'pipe'
    });

    const db = openDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = 1').get();

    expect(order.getmeds_order_id).toBe('GM-20260830-0001');
    expect(order.status).toBe('tracking_shared');
    expect(order.zoho_so_number).toBe('SO-66824');
    expect(order.intake_doctor).toBe('Dr Cruz');
    expect(order.invoicing_from).toBe('Getmeds Philippines Inc.');

    expect(db.prepare('SELECT COUNT(*) n FROM order_items').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM payments').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM dispatch_records').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM order_events').get().n).toBe(1);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='orders_legacy_status'").get()).toBeUndefined();
    db.close();
  });

  test('child tables still reference orders, not the renamed temp table', () => {
    // Since SQLite 3.25, ALTER TABLE RENAME also rewrites references to that
    // table in other tables' schemas. Without legacy_alter_table=ON during
    // the rebuild, all four of these would point at orders_legacy_status and
    // be orphaned by the DROP.
    const db = openDb();
    for (const table of ['order_items', 'payments', 'dispatch_records', 'order_events']) {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      expect(sql).toMatch(/REFERENCES\s+orders\s*\(/i);
      expect(sql).not.toMatch(/orders_legacy_status/i);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  test("the rebuilt table keeps its indexes", () => {
    const db = openDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders' AND name LIKE 'idx_%'")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_orders_medrep_created',
        'idx_orders_status_submitted',
        'idx_orders_customer_id',
        'idx_orders_created_at'
      ])
    );
    db.close();
  });

  test('every status the app can write is accepted afterwards', () => {
    // Sep 1, 2026 (2): asserts the whole list, not just the one status that
    // prompted the rebuild. The first version of the migration guard checked
    // for a single hard-coded status, so the very next status added would
    // have been skipped on an already-rebuilt database and failed at runtime.
    const db = openDb();
    const statuses = [
'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'ready_for_finance_verified', 'ready_for_draft_invoice',
    'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'
    ];
    for (const status of statuses) {
      expect(() => db.prepare('UPDATE orders SET status=? WHERE id=1').run(status)).not.toThrow();
    }
    db.prepare("UPDATE orders SET status='tracking_shared' WHERE id=1").run();
    db.close();
  });

  test('running the migration again is a no-op', () => {
    execFileSync(process.execPath, [path.join(BACKEND, 'src/db/migrate.js')], {
      cwd: BACKEND,
      env: { ...process.env, GETMEDS_DB_DIR: tmpDir },
      stdio: 'pipe'
    });
    const db = openDb();
    expect(db.prepare('SELECT COUNT(*) n FROM orders').get().n).toBe(1);
    expect(db.prepare('SELECT getmeds_order_id FROM orders WHERE id=1').get().getmeds_order_id).toBe('GM-20260830-0001');
    db.close();
  });
});

/**
 * Sep 1, 2026 (5): the status RENAME, which the rebuild performs while copying
 * rows across. This is the part with a real trap in it: 'invoice_sent' maps TO
 * 'ready_for_dispatch', while rows already sitting AT 'ready_for_dispatch'
 * meant something entirely different under the old naming ("Sales Order
 * confirmed, go pack" — no invoice involved) and have to map AWAY from it.
 * Written as sequential UPDATEs those two collide and the just-migrated
 * invoice_sent rows get migrated a second time.
 */
describe('retired statuses are remapped, not dropped', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');

  const BACKEND = path.join(__dirname, '..');
  let tmpDir;
  let dbPath;

  const seed = [
    // [ref, old status, zoho_invoice_id, expected new status]
    ['MIG-WFP', 'waiting_for_payment', null, 'ready_for_draft_invoice'],
    ['MIG-DRAFTED', 'invoice_drafted', 'INV-1', 'ready_for_invoice_sent'],
    ['MIG-SENT', 'invoice_sent', 'INV-2', 'ready_for_dispatch'],
    ['MIG-PAYVER', 'payment_verified', null, 'ready_for_dispatch'],
    // The ambiguous ones. Old ready_for_dispatch with no invoice on file was
    // never invoiced, so it belongs back at the first Finance stage.
    ['MIG-RFD-NOINV', 'ready_for_dispatch', null, 'ready_for_draft_invoice'],
    ['MIG-RFD-INV', 'ready_for_dispatch', 'INV-3', 'ready_for_invoice_sent'],
    // Untouched.
    ['MIG-DISPATCHED', 'dispatched', null, 'dispatched'],
    ['MIG-DONE', 'completed', 'INV-4', 'completed']
  ];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getmeds-rename-'));
    dbPath = path.join(tmpDir, 'getmeds.db');

    // Old schema: the pre-rename status list.
    const oldStatuses = `'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'waiting_for_payment', 'invoice_drafted', 'invoice_sent', 'payment_verified',
    'ready_for_dispatch', 'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'`;
    const oldSchema = fs
      .readFileSync(path.join(BACKEND, 'src/db/schema.sql'), 'utf8')
      .replace(/'draft', 'submitted', 'validating', 'so_pending', 'so_created',[\s\S]*?'cancelled', 'deleted'/, oldStatuses);

    const db = new Database(dbPath);
    db.exec(oldSchema);
    db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('A','a@x.ph','x','medrep')").run();
    db.prepare("INSERT INTO customers (name,type) VALUES ('C','credit')").run();
    for (const [ref, status, invoiceId] of seed) {
      db.prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_invoice_id)
         VALUES (?, 1, 1, ?, 'credit', 100, 'Manila', 'ZSO-' || ?, ?)`
      ).run(ref, status, ref, invoiceId);
    }
    db.close();

    execFileSync(process.execPath, [path.join(BACKEND, 'src/db/migrate.js')], {
      cwd: BACKEND,
      env: { ...process.env, GETMEDS_DB_DIR: tmpDir },
      stdio: 'pipe'
    });
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Four placeholders for four columns — with three, jest silently printed the
  // invoice id where the expected status should be ("becomes null").
  test.each(seed)('%s: %s (invoice %s) becomes %s', (ref, _oldStatus, _invoiceId, expected) => {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status FROM orders WHERE getmeds_order_id = ?').get(ref);
    db.close();
    expect(row).toBeDefined();
    expect(row.status).toBe(expected);
  });

  test('no row is left holding a retired status', () => {
    const db = new Database(dbPath);
    const stragglers = db
      .prepare(
        `SELECT getmeds_order_id, status FROM orders
         WHERE status IN ('waiting_for_payment','invoice_drafted','invoice_sent','payment_verified')`
      )
      .all();
    const count = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    db.close();
    expect(stragglers).toEqual([]);
    expect(count).toBe(seed.length); // nothing dropped on the way across
  });
});
