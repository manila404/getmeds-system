#!/usr/bin/env node
/**
 * Wipe every order and everything hanging off one, leaving the rest of the
 * database alone.
 *
 * Sep 1, 2026. Written after the TestGM- orders were deleted on the Zoho side
 * and the local list needed to match, so testing could restart from nothing.
 *
 * DELETES:  orders, order_items, payments, dispatch_records, order_events,
 *           zoho_sync_queue, and notifications attached to an order.
 * KEEPS:    customers, products, users, roles, sync_state, and any
 *           notification not tied to an order.
 *
 * Customers matter most here: that table holds tens of thousands of rows
 * pulled from the real Zoho org (with their zoho_contact_id mappings), and a
 * full re-sync is a long, paginated job. Nothing in this script touches it.
 *
 * Requires --yes. Run without it for a dry run that shows exactly what would
 * go and what would stay — the whole point being that you see the numbers
 * before anything is destroyed, not after.
 *
 *   node scripts/reset-orders.js            # dry run
 *   node scripts/reset-orders.js --yes      # actually delete
 *   node scripts/reset-orders.js --yes --keep-ids   # don't reset the id counter
 */
const db = require('../src/db/database');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const keepIds = args.includes('--keep-ids');

// Children first, so this works whether or not the ON DELETE CASCADE rules in
// schema.sql are being enforced (the foreign_keys pragma can be off on some
// filesystems — see src/db/database.js).
const ORDER_SCOPED = [
  ['order_items', 'DELETE FROM order_items'],
  ['payments', 'DELETE FROM payments'],
  ['dispatch_records', 'DELETE FROM dispatch_records'],
  ['order_events', 'DELETE FROM order_events'],
  ['zoho_sync_queue', 'DELETE FROM zoho_sync_queue'],
  ['notifications (order-linked)', 'DELETE FROM notifications WHERE order_id IS NOT NULL'],
  ['orders', 'DELETE FROM orders']
];

const count = (sql) => {
  try {
    return db.prepare(sql).get().n;
  } catch (err) {
    return null; // table may not exist on an older database
  }
};

const before = {
  orders: count('SELECT COUNT(*) n FROM orders'),
  order_items: count('SELECT COUNT(*) n FROM order_items'),
  payments: count('SELECT COUNT(*) n FROM payments'),
  dispatch_records: count('SELECT COUNT(*) n FROM dispatch_records'),
  order_events: count('SELECT COUNT(*) n FROM order_events'),
  zoho_sync_queue: count('SELECT COUNT(*) n FROM zoho_sync_queue'),
  'notifications (order-linked)': count('SELECT COUNT(*) n FROM notifications WHERE order_id IS NOT NULL')
};

const keeping = {
  customers: count('SELECT COUNT(*) n FROM customers'),
  products: count('SELECT COUNT(*) n FROM products'),
  users: count('SELECT COUNT(*) n FROM users'),
  'notifications (not order-linked)': count('SELECT COUNT(*) n FROM notifications WHERE order_id IS NULL')
};

console.log('\nWILL DELETE');
for (const [label, n] of Object.entries(before)) {
  console.log(`  ${String(label).padEnd(32)} ${n === null ? 'n/a' : n}`);
}
console.log('\nWILL KEEP');
for (const [label, n] of Object.entries(keeping)) {
  console.log(`  ${String(label).padEnd(32)} ${n === null ? 'n/a' : n}`);
}

if (!confirmed) {
  console.log('\nDry run — nothing was deleted.');
  console.log('Re-run with --yes to go ahead:  node scripts/reset-orders.js --yes\n');
  process.exit(0);
}

const wipe = db.transaction(() => {
  for (const [, sql] of ORDER_SCOPED) db.prepare(sql).run();

  // Start ids back at 1. `orders.id` is AUTOINCREMENT, so SQLite keeps a
  // high-water mark in sqlite_sequence that survives a DELETE — without this
  // the "clean slate" would still hand out id 47. Safe precisely because
  // every row that could have referenced an old id has just gone. Skip it
  // with --keep-ids if you would rather ids never be reused.
  if (!keepIds) {
    try {
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('orders','order_items','payments','dispatch_records','order_events','notifications','zoho_sync_queue')").run();
    } catch (err) {
      console.warn(`  (could not reset id counters: ${err.message})`);
    }
  }
});

wipe();

const remaining = count('SELECT COUNT(*) n FROM orders');
console.log(`\n✅ Orders cleared. orders table now holds ${remaining} row(s).`);
console.log(`   Customers kept: ${keeping.customers}   Products kept: ${keeping.products}   Users kept: ${keeping.users}`);
console.log('   The next order will be numbered -0001 for today.\n');
