#!/usr/bin/env node
/**
 * Delete orders belonging to one or more local test customers — by default,
 * anything named TEST-CUSTOMER* (the TEST-CUSTOMER_1/2/3 fixtures
 * orders.controller.js's ZOHO_TEST_CUSTOMER_IDS safety gate is built
 * around) — and nothing else.
 *
 * Sep 8, 2026.
 *
 * WHAT THIS DELETES
 *   Rows from `orders` matching the customer filter, plus whatever Postgres
 *   cascades from that automatically: order_items, payments,
 *   dispatch_records, payment_proofs, order_events, notifications, and
 *   zoho_sync_queue. Every one of those has
 *   `order_id ... REFERENCES orders(id) ON DELETE CASCADE` in
 *   schema.pg.sql, so a single DELETE FROM orders is enough — unlike
 *   reset-orders.js (written for SQLite, where cascade enforcement was not
 *   guaranteed and had to be done by hand, table by table).
 *
 * WHAT THIS NEVER TOUCHES
 *   - The customer row itself, unless you pass --include-customer. Kept by
 *     default because TEST-CUSTOMER_1/2/3 are live Zoho contacts this app's
 *     own safety gate depends on for restricted live-order testing — you
 *     usually want to empty them out, not remove them.
 *   - products, users, order_id_sequences, sync_state — completely
 *     untouched, always.
 *   - Zoho, in any way. This script only requires src/db/database (the
 *     Postgres layer) — it never requires src/integrations/zoho, and
 *     ZohoAdapter.js itself has no delete/void/bulk-delete method for
 *     anything to call even if it did (see that file's own header comment).
 *     Whatever this script deletes locally has zero effect on the live
 *     Zoho org.
 *
 * Order numbering (GM-YYYYMMDD-NNNN) comes from its own counter in
 * order_id_sequences and is untouched here — deleting orders leaves gaps in
 * that day's numbering. orderIdService.js's own comment already documents
 * that as normal and harmless: numbers are consumed, not reused, by design.
 *
 * Requires --yes, same convention as reset-orders.js/fresh-start.js.
 * Without it, this is a dry run: it lists every matched customer and every
 * order that WOULD be deleted, and deletes nothing.
 *
 *   node scripts/delete-test-orders.js                                  # dry run, default filter (name LIKE 'TEST-CUSTOMER%')
 *   node scripts/delete-test-orders.js --yes                            # delete, default filter
 *   node scripts/delete-test-orders.js --customer "TEST-CUSTOMER_1" --yes
 *   node scripts/delete-test-orders.js --customer "TEST-CUSTOMER_1,TEST-CUSTOMER_2" --yes
 *   node scripts/delete-test-orders.js --include-customer --yes         # also delete the now order-less customer row(s)
 */
require('dotenv').config();
const db = require('../src/db/database');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const includeCustomer = args.includes('--include-customer');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

// Default filter: every customer whose name starts with "TEST-CUSTOMER"
// (case-insensitive — LIKE is translated to ILIKE for Postgres, see
// sqlToPg.js). Pass --customer with one exact name, or a comma-separated
// list of exact names, to target something else instead.
const customerArg = argValue('--customer');
const nameFilters = customerArg
  ? customerArg.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

async function main() {
  await db.init();

  console.log('\n── Delete test-customer orders ─────────────────────────\n');

  const customers = nameFilters
    ? await db
        .prepare(`SELECT id, name, type, zoho_contact_id, source FROM customers WHERE name IN (${nameFilters.map(() => '?').join(',')}) ORDER BY name`)
        .all(nameFilters)
    : await db
        .prepare(`SELECT id, name, type, zoho_contact_id, source FROM customers WHERE name LIKE ? ORDER BY name`)
        .all('TEST-CUSTOMER%');

  if (!customers.length) {
    console.log(
      nameFilters
        ? `No customer found matching: ${nameFilters.join(', ')}\n`
        : `No customer found matching "TEST-CUSTOMER%".\n`
    );
    return;
  }

  console.log(`Matched ${customers.length} customer(s):\n`);
  let totalOrders = 0;

  for (const c of customers) {
    const orders = await db
      .prepare(`SELECT getmeds_order_id, status, total_amount, created_at FROM orders WHERE customer_id = ? ORDER BY created_at`)
      .all(c.id);
    totalOrders += orders.length;

    console.log(
      `  #${c.id}  ${c.name}  (${c.type}, source=${c.source}${c.zoho_contact_id ? `, zoho_contact_id=${c.zoho_contact_id}` : ''})`
    );
    console.log(`      ${orders.length} order(s)`);
    for (const o of orders) {
      console.log(`        ${o.getmeds_order_id.padEnd(20)} ${o.status.padEnd(28)} ${o.total_amount ?? 0}`);
    }
  }

  if (!totalOrders) {
    console.log('\nNothing to delete — none of the matched customers have any orders.');
    if (includeCustomer && confirmed) {
      console.log('--include-customer was given, so the customer row(s) above will still be deleted.\n');
    } else {
      console.log('');
      return;
    }
  } else {
    console.log(`\nTOTAL: ${totalOrders} order(s) across ${customers.length} customer(s).`);
    console.log('Cascades automatically (schema.pg.sql ON DELETE CASCADE): order_items,');
    console.log('payments, dispatch_records, payment_proofs, order_events, notifications,');
    console.log('and zoho_sync_queue rows for each of those orders.');
  }

  console.log(
    includeCustomer
      ? '\n--include-customer given: the customer row(s) above will ALSO be deleted, after their orders.'
      : '\nCustomer row(s) will be KEPT (pass --include-customer to also delete them).'
  );
  console.log('\nZoho is never contacted by this script — whatever you choose below has zero');
  console.log('effect on the live Zoho org.');

  if (!confirmed) {
    console.log('\nDry run — nothing was deleted.');
    console.log('Re-run with --yes to go ahead.\n');
    return;
  }

  const customerIds = customers.map((c) => c.id);
  const idPlaceholders = customerIds.map(() => '?').join(',');

  const doDelete = db.transaction(async () => {
    let ordersDeleted = 0;
    if (totalOrders) {
      const result = await db.prepare(`DELETE FROM orders WHERE customer_id IN (${idPlaceholders})`).run(customerIds);
      ordersDeleted = result.changes;
    }
    let customersDeleted = 0;
    if (includeCustomer) {
      const delCust = await db.prepare(`DELETE FROM customers WHERE id IN (${idPlaceholders})`).run(customerIds);
      customersDeleted = delCust.changes;
    }
    return { ordersDeleted, customersDeleted };
  });

  const { ordersDeleted, customersDeleted } = await doDelete();

  console.log(`\n✅ Deleted ${ordersDeleted} order(s)` + (includeCustomer ? ` and ${customersDeleted} customer row(s).` : '.'));
  console.log('   Nothing in Zoho was touched.\n');
}

main()
  .catch((err) => {
    console.error('\nFailed:', err.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    db.close().finally(() => process.exit(process.exitCode || 0));
  });
