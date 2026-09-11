#!/usr/bin/env node
/**
 * Command-line front end for the Zoho Sales Order import.
 *
 * Sep 1, 2026 (6). Originally this script WAS the feature — the only way to
 * adopt Sales Orders that already existed in Zoho, written as a dry-runnable
 * five-at-a-time demo to answer "can this system be the hub for orders it did
 * not create".
 *
 * Sep 9, 2026. The answer turned out to be yes, so it became a real feature:
 * the logic now lives in src/services/zohoOrderImportService.js and is reached
 * from a button on the Management Dashboard. This file is a thin CLI over that
 * same service — deliberately thin, because the previous version held its own
 * copy of the adopt-and-reconcile logic, and two copies of a thing this
 * fiddly diverge. (It also still spoke better-sqlite3's synchronous API and
 * had been broken since the Sep 2 PostgreSQL port, which is what a second copy
 * nobody runs looks like.)
 *
 * What the CLI keeps that the button does not have is the DRY RUN, which is
 * worth having before pointing this at a real org for the first time.
 *
 * ── READ-ONLY TOWARD ZOHO ────────────────────────────────────────────────────
 * Three GETs — list, detail, comments. Nothing here can change anything in
 * Zoho; the adapter has no method that could (see ZohoAdapter.js). Every write
 * is to the local database.
 *
 *   node scripts/import-zoho-orders.js            # dry run — look, don't touch
 *   node scripts/import-zoho-orders.js --limit 20 # how many to inspect (default 10)
 *   node scripts/import-zoho-orders.js --yes      # import + build trails
 *   node scripts/import-zoho-orders.js --quick    # with --yes: only what changed
 *   node scripts/import-zoho-orders.js --report   # what's already imported, with
 *                                                 # each trail (local DB only —
 *                                                 # makes no Zoho calls)
 */
// The old better-sqlite3 data layer opened a file by relative path, so this
// script never needed the environment. A network database does: without this,
// DATABASE_URL is unset here and the first query fails with "DATABASE_URL is
// not set" even though .env has it.
require('dotenv').config();
// Share the database politely: this is a bulk job, and the deployed app is on
// the same Supabase pooler. See lib/batch-job.js.
require('./lib/batch-job');

const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { importSalesOrders, findLocalOrder, IMPORT_MAX } = require('../src/services/zohoOrderImportService');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const reportOnly = args.includes('--report');
const quick = args.includes('--quick');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) || 10 : 10;

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

/**
 * Every adopted order already in the local database, with the Zoho ids it came
 * from and the trail that was rebuilt for it. Local reads only — no Zoho calls
 * at all, so it is free to run as often as you like while checking whether an
 * import landed correctly.
 */
async function printReport() {
  const orders = await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.status, o.total_amount,
              o.zoho_so_id, o.zoho_so_number, o.zoho_invoice_number, o.last_reconciled_at,
              c.name AS customer_name, c.zoho_contact_id
         FROM orders o
         LEFT JOIN customers c ON o.customer_id = c.id
        WHERE o.getmeds_order_id LIKE 'ZOHO-%'
        ORDER BY o.id`
    )
    .all();

  if (!orders.length) {
    console.log('\nNo imported orders yet. Run without --report to see what is available.\n');
    return;
  }

  console.log(`\n${orders.length} order(s) adopted from Zoho:\n`);

  for (const o of orders) {
    console.log('─'.repeat(96));
    console.log(`${o.getmeds_order_id}   ${o.customer_name || '(customer missing)'}`);
    console.log(
      `  status ${o.status}   total ${o.total_amount}` +
        (o.zoho_invoice_number ? `   invoice ${o.zoho_invoice_number}` : '')
    );
    console.log(
      `  zoho SO ${o.zoho_so_number || '?'} (id ${o.zoho_so_id})` +
        `   contact ${o.zoho_contact_id || '—'}` +
        `   last pulled ${o.last_reconciled_at || 'never'}`
    );

    const events = await db
      .prepare(
        'SELECT event_type, old_status, new_status, actor_name, notes FROM order_events WHERE order_id = ? ORDER BY created_at, id'
      )
      .all(o.id);

    if (!events.length) {
      console.log('  (no trail — nothing has happened to this Sales Order in Zoho yet)');
      continue;
    }
    for (const e of events) {
      const hop = e.old_status || e.new_status ? `${e.old_status || '—'} → ${e.new_status || '—'}` : '';
      // ZOHO_LOG entries carry Zoho's own wording, which is the interesting
      // part of them — the status hop is empty by definition.
      const tail = e.event_type === 'ZOHO_LOG' ? (e.notes || '').slice(0, 60) : hop;
      console.log(`   • ${pad(e.event_type, 26)} ${pad(tail, 62)} ${e.actor_name || 'System'}`);
    }
  }
  console.log('─'.repeat(96) + '\n');
}

/** Report what an import would do, writing nothing. */
async function dryRun() {
  let salesorders;
  try {
    const res = await zoho.listRecentSalesOrders(LIMIT);
    salesorders = res.salesorders || [];
  } catch (err) {
    console.error(`\n✗ Could not read Sales Orders from Zoho: ${err.message}\n`);
    process.exit(1);
  }

  if (!salesorders.length) {
    console.log('\nZoho returned no Sales Orders.\n');
    return;
  }

  console.log(`Read the ${salesorders.length} most recent Sales Order(s) from Zoho.\n`);
  console.log(pad('SALES ORDER', 14) + pad('ZOHO STATUS', 14) + pad('CUSTOMER', 32) + 'WOULD');
  console.log('─'.repeat(96));

  for (const so of salesorders) {
    const { order, matchedBy } = await findLocalOrder(so);
    const would = order
      ? matchedBy === 'zoho_so_id'
        ? `already here (${order.getmeds_order_id}) — refresh its trail`
        : `link to ${order.getmeds_order_id} (matched by reference number)`
      : `import as ZOHO-${so.salesorder_number || so.salesorder_id}`;

    console.log(
      pad(so.salesorder_number || so.salesorder_id, 14) +
        pad(so.status || '?', 14) +
        pad((so.customer_name || '').slice(0, 30), 32) +
        would
    );
  }

  console.log(
    `\nDry run — nothing written. Re-run with --yes to import (up to ${IMPORT_MAX} per run; ` +
      'set ZOHO_SO_IMPORT_MAX to change that).\n'
  );
}

(async () => {
  await db.init();

  if (reportOnly) {
    await printReport();
    await db.close();
    return;
  }

  console.log(`\nZoho mode: ${zoho.mode}`);
  if (zoho.mode === 'mock') {
    console.log('⚠️  ZOHO_MODE=mock — this will read the in-memory fixture, not your real org.\n');
  }

  if (!confirmed) {
    await dryRun();
    await db.close();
    return;
  }

  const mode = quick ? 'quick' : 'full';
  console.log(`\nImporting (${mode})…\n`);

  const summary = await importSalesOrders({
    mode,
    onFetched: (n) => process.stdout.write(`\r  listing Sales Orders from Zoho… ${n}`),
    onProgress: (done, total) => process.stdout.write(`\r  processing ${done}/${total}          `)
  });

  console.log('\n');
  console.log(`  found in Zoho        ${summary.total_from_zoho}`);
  console.log(`  needed work          ${summary.needs_work}`);
  console.log(`  processed this run   ${summary.considered}`);
  console.log(`  imported             ${summary.imported}`);
  console.log(`  re-linked            ${summary.linked}`);
  console.log(`  already here         ${summary.already_present}`);
  console.log(`  skipped              ${summary.skipped}`);
  console.log(`  checkpoints built    ${summary.checkpoints}`);
  console.log(`  Zoho log entries     ${summary.log_entries}`);
  console.log(`  salespersons filled  ${summary.salespersons_backfilled}`);
  if (summary.failed) {
    console.log(`  failed             ${summary.failed}`);
    for (const f of summary.failures) console.log(`     - ${f.salesorder_id}: ${f.message}`);
  }
  if (summary.remaining) {
    console.log(
      `\n  ${summary.remaining} Sales Order(s) still need importing, beyond this run's limit of ` +
        `${summary.capped_at}. Run this again to take the next batch.`
    );
  }

  console.log('\n✅ Done. Open the Orders list — each imported order carries the trail Zoho knows about.\n');
  await db.close();
})().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
