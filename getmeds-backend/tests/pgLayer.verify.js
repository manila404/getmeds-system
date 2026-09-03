'use strict';

/**
 * Verification harness for the Postgres data layer.
 *
 * Runs against a REAL PostgreSQL with schema.pg.sql applied. Every assertion
 * here corresponds to something that would otherwise fail silently in
 * production: a placeholder mangled inside a string literal, a search that
 * quietly returns nothing, a transaction that protects nothing because its
 * statements landed on different pooled connections.
 */

const assert = require('assert');
const db = require('./pg');
const { translate } = require('./sqlToPg');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

/**
 * THIS HARNESS TRUNCATES EVERY TABLE. It must never be pointed at a database
 * holding real orders. The guard below is deliberately annoying: an empty
 * DATABASE_URL, or one that does not look like a scratch database, stops the
 * run rather than trusting whoever typed the command.
 */
function guardScratchDatabase() {
  const url = process.env.DATABASE_URL || '';
  const looksLocal = /localhost|127\.0\.0\.1|host=\/tmp|\/var\/run\/postgresql/.test(url);
  const named = /getmeds_test|_test\b|scratch/.test(url);
  if (process.env.I_KNOW_THIS_WIPES_THE_DATABASE === 'yes') return;
  if (looksLocal || named) return;
  console.error(
    '\nRefusing to run: this harness TRUNCATES every table and DATABASE_URL\n' +
      'does not look like a local or _test database.\n\n' +
      `  DATABASE_URL = ${url.replace(/:[^:@/]*@/, ':****@') || '(unset)'}\n\n` +
      'Point it at a scratch database, or set\n' +
      '  I_KNOW_THIS_WIPES_THE_DATABASE=yes\n'
  );
  process.exit(2);
}

async function main() {
  guardScratchDatabase();
  await db.init();

  // ---------------------------------------------------------------- pure
  section('1. Statement translation (pure, no database)');

  await test('? becomes $1..$n in order', () => {
    const t = translate('SELECT * FROM users WHERE a = ? AND b = ? AND c = ?');
    assert.strictEqual(t.text, 'SELECT * FROM users WHERE a = $1 AND b = $2 AND c = $3');
    assert.strictEqual(t.paramCount, 3);
  });

  await test('? inside a string literal is NOT a placeholder', () => {
    const t = translate("INSERT INTO notifications (message) VALUES ('Ready? yes', ?)");
    assert.ok(t.text.includes("'Ready? yes'"), 'literal was mangled: ' + t.text);
    assert.strictEqual(t.paramCount, 1);
    assert.ok(t.text.endsWith('$1)'));
  });

  await test('escaped quote inside a literal does not end it', () => {
    const t = translate("SELECT ? WHERE name = 'St. Luke''s ? Center' AND x = ?");
    assert.strictEqual(t.paramCount, 2);
    assert.ok(t.text.includes("'St. Luke''s ? Center'"));
  });

  await test('LIKE in a -- comment is left alone', () => {
    const t = translate('SELECT 1 -- LIKE this\nWHERE name LIKE ?');
    assert.ok(t.text.includes('-- LIKE this'), 'comment rewritten: ' + t.text);
    assert.ok(t.text.includes('name ILIKE $1'));
  });

  await test('NOT LIKE becomes NOT ILIKE, not NOT+ILIKE twice', () => {
    const t = translate('SELECT 1 WHERE a NOT LIKE ?');
    assert.ok(/NOT ILIKE/.test(t.text), t.text);
    assert.ok(!/ILIKE\s+ILIKE/.test(t.text), t.text);
  });

  await test("datetime('now') becomes iso_now()", () => {
    const t = translate("UPDATE products SET last_synced_at = datetime('now') WHERE id = ?");
    assert.ok(t.text.includes('iso_now()'), t.text);
    assert.ok(!/datetime\s*\(/i.test(t.text), t.text);
  });

  await test("strftime('%Y-%m-%dT%H:%M:%fZ','now') becomes iso_now()", () => {
    const t = translate(
      "INSERT INTO order_events (created_at) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
    );
    assert.ok(t.text.includes('iso_now()'), t.text);
  });

  await test('an untranslated SQLite date function is reported, not hidden', () => {
    const t = translate("SELECT julianday('now')");
    assert.ok(t.notes.some((n) => n.startsWith('UNTRANSLATED')), JSON.stringify(t.notes));
  });

  // ------------------------------------------------------------ round-trip
  section('2. Round-trip against real PostgreSQL');

  await db.exec('TRUNCATE order_events, order_items, notifications, zoho_sync_queue, dispatch_records, payments, orders, customers, products, users, sync_state, order_id_sequences RESTART IDENTITY CASCADE');

  await test('run() reports lastInsertRowid for a table with an id column', async () => {
    const r = await db
      .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('Ana Cruz', 'ana@getmeds.ph', 'hash', 'medrep');
    assert.strictEqual(r.changes, 1);
    assert.ok(Number.isInteger(r.lastInsertRowid), 'got ' + r.lastInsertRowid);
  });

  await test('the same row reads back through get()', async () => {
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get('ana@getmeds.ph');
    assert.strictEqual(row.name, 'Ana Cruz');
    assert.strictEqual(row.is_active, 1, 'booleans must stay 0/1, got ' + typeof row.is_active);
  });

  await test('run() on a table WITHOUT an id column does not break (sync_state upsert)', async () => {
    const sql =
      "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = iso_now()';
    const a = await db.prepare(sql).run('customers_watermark', '2026-09-01');
    assert.strictEqual(a.changes, 1);
    const b = await db.prepare(sql).run('customers_watermark', '2026-09-02');
    assert.strictEqual(b.changes, 1);
    const row = await db.prepare('SELECT value FROM sync_state WHERE key = ?').get('customers_watermark');
    assert.strictEqual(row.value, '2026-09-02');
  });

  await test("iso_now() writes the same format as JS toISOString()", async () => {
    const row = await db.prepare('SELECT updated_at FROM sync_state WHERE key = ?').get('customers_watermark');
    assert.match(
      row.updated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      'got ' + row.updated_at
    );
  });

  await test('the salesperson generated column still computes', async () => {
    await db
      .prepare(
        'INSERT INTO users (name, email, password_hash, role, display_name, division) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('Bea Reyes', 'bea@getmeds.ph', 'hash', 'medrep', ' Bea Reyes ', ' NCR ');
    const row = await db.prepare('SELECT salesperson FROM users WHERE email = ?').get('bea@getmeds.ph');
    assert.strictEqual(row.salesperson, 'NCR | Bea Reyes');
  });

  await test('salesperson is NULL when division is missing', async () => {
    await db
      .prepare('INSERT INTO users (name, email, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)')
      .run('Cy Tan', 'cy@getmeds.ph', 'hash', 'finance', 'Cy Tan');
    const row = await db.prepare('SELECT salesperson FROM users WHERE email = ?').get('cy@getmeds.ph');
    assert.strictEqual(row.salesperson, null);
  });

  await test('a ? inside a literal survives a real INSERT', async () => {
    await db
      .prepare('INSERT INTO customers (name, type) VALUES (?, ?)')
      .run("Ready? Clinic", 'direct');
    const row = await db.prepare('SELECT name FROM customers WHERE type = ?').get('direct');
    assert.strictEqual(row.name, 'Ready? Clinic');
  });

  // ------------------------------------------------------------ constraints
  section('3. The constraints that caught real bugs still bite');

  await test('getmeds_order_id UNIQUE rejects a duplicate', async () => {
    const cust = await db.prepare('INSERT INTO customers (name, type) VALUES (?, ?)').run('St. Lukes Medical Center', 'credit');
    const rep = await db.prepare('SELECT id FROM users WHERE email = ?').get('ana@getmeds.ph');
    const ins = db.prepare(
      'INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, customer_type, delivery_address) VALUES (?, ?, ?, ?, ?)'
    );
    await ins.run('GM-2609-0001', cust.lastInsertRowid, rep.id, 'credit', 'Manila');
    await assert.rejects(
      () => ins.run('GM-2609-0001', cust.lastInsertRowid, rep.id, 'credit', 'Manila'),
      /duplicate key|unique/i
    );
  });

  await test('status CHECK still rejects the retired waiting_for_payment', async () => {
    await assert.rejects(
      () => db.prepare('UPDATE orders SET status = ? WHERE getmeds_order_id = ?').run('waiting_for_payment', 'GM-2609-0001'),
      /check constraint/i
    );
  });

  await test('a foreign key to a missing user is rejected', async () => {
    await assert.rejects(
      () =>
        db
          .prepare(
            'INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, customer_type, delivery_address) VALUES (?, ?, ?, ?, ?)'
          )
          .run('GM-2609-9999', 1, 999999, 'credit', 'Manila'),
      /foreign key/i
    );
  });

  // ----------------------------------------------------------- transactions
  section('4. Transactions (the AsyncLocalStorage claim)');

  await test('a committed transaction persists every statement', async () => {
    const tx = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Paracetamol 500mg', 'SKU-A', 12.5);
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Amoxicillin 250mg', 'SKU-B', 30);
    });
    await tx();
    const rows = await db.prepare('SELECT sku FROM products ORDER BY sku').all();
    assert.deepStrictEqual(rows.map((r) => r.sku), ['SKU-A', 'SKU-B']);
  });

  await test('a throwing transaction rolls back BOTH statements', async () => {
    const tx = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Ibuprofen', 'SKU-C', 15);
      throw new Error('Zoho refused the sales order');
    });
    await assert.rejects(tx, /Zoho refused/);
    const row = await db.prepare('SELECT sku FROM products WHERE sku = ?').get('SKU-C');
    assert.strictEqual(row, undefined, 'SKU-C survived a rollback — the transaction protected nothing');
  });

  await test('a CHECK violation inside a transaction rolls back the whole block', async () => {
    const before = (await db.prepare('SELECT COUNT(*)::int AS n FROM products').get()).n;
    const tx = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Good', 'SKU-D', 10);
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Bad', 'SKU-E', -5);
    });
    await assert.rejects(tx, /check constraint/i);
    const after = (await db.prepare('SELECT COUNT(*)::int AS n FROM products').get()).n;
    assert.strictEqual(after, before, 'partial write survived');
  });

  await test('concurrent transactions do not bleed into one another', async () => {
    // The real risk: if both transactions shared a pooled connection, one's
    // ROLLBACK would discard the other's work.
    const good = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Keeps', 'SKU-KEEP', 1);
      await new Promise((r) => setTimeout(r, 60));
    });
    const bad = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Drops', 'SKU-DROP', 1);
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('rollback me');
    });
    const [, r2] = await Promise.allSettled([good(), bad()]);
    assert.strictEqual(r2.status, 'rejected');
    assert.ok(await db.prepare('SELECT 1 FROM products WHERE sku = ?').get('SKU-KEEP'), 'committed row was lost');
    assert.strictEqual(await db.prepare('SELECT 1 FROM products WHERE sku = ?').get('SKU-DROP'), undefined, 'rolled-back row survived');
  });

  await test('nested transaction() joins the outer one instead of deadlocking', async () => {
    const inner = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Inner', 'SKU-IN', 2);
    });
    const outer = db.transaction(async () => {
      await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, ?)').run('Outer', 'SKU-OUT', 2);
      await inner();
    });
    await outer();
    assert.ok(await db.prepare('SELECT 1 FROM products WHERE sku = ?').get('SKU-IN'));
    assert.ok(await db.prepare('SELECT 1 FROM products WHERE sku = ?').get('SKU-OUT'));
  });

  // -------------------------------------------------------- the LIKE trap
  section('5. The LIKE trap the migration plan flagged');

  await test('lowercase search finds a capitalised customer (SQLite behaviour restored)', async () => {
    const rows = await db
      .prepare('SELECT name FROM customers WHERE (name LIKE ? OR contact_person LIKE ? OR contact_number LIKE ?)')
      .all('%lukes%', '%lukes%', '%lukes%');
    assert.strictEqual(rows.length, 1, 'autocomplete returned ' + rows.length + ' rows for "lukes"');
    assert.strictEqual(rows[0].name, 'St. Lukes Medical Center');
  });

  await test('raw (untranslated) LIKE returns nothing — proving the trap is real', async () => {
    // Bypasses the wrapper entirely: this is what a verbatim port would run.
    const res = await db._rawQuery("SELECT name FROM customers WHERE name LIKE '%lukes%'");
    assert.strictEqual(res.length, 0, 'expected case-sensitive LIKE to miss, got ' + res.length);
  });

  // ------------------------------------------------------------- pragma
  section('6. PRAGMA shim');

  await test('pragma("table_info(users)") lists real columns', async () => {
    const cols = await db.pragma('table_info(users)');
    const names = cols.map((c) => c.name);
    for (const expected of ['id', 'email', 'is_test_account', 'salesperson']) {
      assert.ok(names.includes(expected), 'missing column ' + expected);
    }
  });

  await test('pragma("journal_mode = WAL") is a harmless no-op', async () => {
    const r = await db.pragma('journal_mode = WAL');
    assert.deepStrictEqual(r, []);
  });

  // -------------------------------------------------------------- report
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
  await db.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nHarness crashed:', err);
  await db.close().catch(() => {});
  process.exit(1);
});
