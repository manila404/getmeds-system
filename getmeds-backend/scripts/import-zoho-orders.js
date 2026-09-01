#!/usr/bin/env node
/**
 * Adopt Sales Orders that already exist in Zoho into this app, then rebuild
 * each one's audit trail from Zoho's own record of it.
 *
 * Sep 1, 2026 (6). The question this answers: can this system be the central
 * hub for order information even when the order was NOT created here? Until
 * now every code path assumed the app created the Sales Order and therefore
 * already had a local row to hang events on. This is the other direction.
 *
 * ── READ-ONLY TOWARD ZOHO ────────────────────────────────────────────────────
 * This script calls exactly three Zoho endpoints, all GETs:
 *   listRecentSalesOrders  (one page, newest first)
 *   getSalesOrder          (per order, for line items / invoices / packages)
 *   — and nothing else. It never calls createSalesOrder, and the adapter has
 *   no update, confirm, invoice, ship, void or delete method to call even by
 *   accident (see ZohoAdapter.js). Nothing this script does can change
 *   anything in Zoho. All writes are to the LOCAL SQLite database.
 *
 * ── DRY RUN BY DEFAULT ───────────────────────────────────────────────────────
 * Without --yes it reports exactly what it would import and what it could not
 * match, and writes nothing at all.
 *
 *   node scripts/import-zoho-orders.js                 # look, don't touch
 *   node scripts/import-zoho-orders.js --limit 5       # how many (default 5)
 *   node scripts/import-zoho-orders.js --yes           # import + build trails
 *   node scripts/import-zoho-orders.js --report        # what's already imported,
 *                                                      # with each trail (local DB
 *                                                      # only — no Zoho calls)
 *
 * ── WHAT AN ADOPTED ORDER LOOKS LIKE ─────────────────────────────────────────
 * `getmeds_order_id` is `ZOHO-<salesorder_number>`, not a GM-/TestGM- id, so an
 * adopted order is never mistaken for one this app raised. It starts at
 * `so_created` and every subsequent stage is then reconstructed by the normal
 * reconcile — the same code the webhooks and the poller use. Nothing about the
 * trail is fabricated here; it is whatever Zoho says happened.
 */
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { reconcileOrderFully } = require('../src/services/zohoReconcileService');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const reportOnly = args.includes('--report');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) || 5 : 5;

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

function findLocalCustomer(zohoContactId, customerName) {
  if (zohoContactId) {
    const byId = db.prepare('SELECT * FROM customers WHERE zoho_contact_id = ?').get(String(zohoContactId));
    if (byId) return { customer: byId, matchedBy: 'zoho_contact_id' };
  }
  if (customerName) {
    const byName = db.prepare('SELECT * FROM customers WHERE name = ? COLLATE NOCASE').get(customerName);
    if (byName) return { customer: byName, matchedBy: 'name' };
  }
  return { customer: null, matchedBy: null };
}

function findLocalProduct(line) {
  if (line.item_id) {
    const byId = db.prepare('SELECT * FROM products WHERE zoho_item_id = ?').get(String(line.item_id));
    if (byId) return byId;
  }
  if (line.sku) {
    const bySku = db.prepare('SELECT * FROM products WHERE sku = ? COLLATE NOCASE').get(line.sku);
    if (bySku) return bySku;
  }
  if (line.name) {
    const byName = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(line.name);
    if (byName) return byName;
  }
  return null;
}

/**
 * Adopted orders have no MedRep — nobody in this app raised them. The column
 * is NOT NULL and references users(id), so one has to be chosen: an admin,
 * flagged in the intake notes so the trail never implies a rep submitted it.
 */
function systemActor() {
  return (
    db.prepare("SELECT id, name FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() ||
    db.prepare('SELECT id, name FROM users ORDER BY id LIMIT 1').get()
  );
}


/**
 * Show every adopted order already in the local database, with the Zoho ids it
 * came from and the trail that was rebuilt for it. Reads the local database
 * only — makes no Zoho calls at all, so it is free to run as often as you like
 * while checking whether an import landed correctly.
 */
function printReport() {
  const orders = db.prepare(`
    SELECT o.id, o.getmeds_order_id, o.status, o.total_amount,
           o.zoho_so_id, o.zoho_so_number, o.zoho_invoice_number, o.last_reconciled_at,
           c.name AS customer_name, c.zoho_contact_id
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    WHERE o.getmeds_order_id LIKE 'ZOHO-%'
    ORDER BY o.id
  `).all();

  if (!orders.length) {
    console.log('\nNo imported orders yet. Run without --report to see what is available.\n');
    return;
  }

  console.log(`\n${orders.length} order(s) adopted from Zoho:\n`);

  for (const o of orders) {
    console.log('─'.repeat(96));
    console.log(`${o.getmeds_order_id}   ${o.customer_name || '(customer missing)'}`);
    console.log(
      `  status ${o.status}` +
      `   total ${o.total_amount}` +
      (o.zoho_invoice_number ? `   invoice ${o.zoho_invoice_number}` : '')
    );
    console.log(
      `  zoho SO ${o.zoho_so_number || '?'} (id ${o.zoho_so_id})` +
      `   contact ${o.zoho_contact_id || '—'}` +
      `   last pulled ${o.last_reconciled_at || 'never'}`
    );

    const events = db.prepare(
      'SELECT event_type, old_status, new_status, actor_name, created_at FROM order_events WHERE order_id = ? ORDER BY id'
    ).all(o.id);

    if (!events.length) {
      console.log('  (no trail — nothing has happened to this Sales Order in Zoho yet)');
      continue;
    }
    for (const e of events) {
      const hop = e.old_status || e.new_status ? `${e.old_status || '—'} → ${e.new_status || '—'}` : '';
      console.log(`   • ${pad(e.event_type, 26)} ${pad(hop, 46)} ${e.actor_name || 'System'}`);
    }
  }
  console.log('─'.repeat(96) + '\n');
}

(async () => {
  if (reportOnly) {
    printReport();
    process.exit(0);
  }

  console.log(`\nZoho mode: ${zoho.mode}`);
  if (zoho.mode === 'mock') {
    console.log('⚠️  ZOHO_MODE=mock — this will read the in-memory fixture, not your real org.\n');
  }

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
    process.exit(0);
  }

  console.log(`Read ${salesorders.length} most recent Sales Order(s) from Zoho.\n`);
  const actor = systemActor();
  const plans = [];

  for (const summary of salesorders) {
    const id = summary.salesorder_id;
    let full = summary;
    try {
      const detail = await zoho.getSalesOrder(id);
      if (detail?.salesorder) full = detail.salesorder;
    } catch (err) {
      console.warn(`  (could not fetch detail for ${summary.salesorder_number}: ${err.message})`);
    }

    const localRef = `ZOHO-${full.salesorder_number || id}`;
    const existing = db.prepare('SELECT id, getmeds_order_id FROM orders WHERE zoho_so_id = ? OR getmeds_order_id = ?').get(String(id), localRef);
    const { customer, matchedBy } = findLocalCustomer(full.customer_id, full.customer_name);

    const lines = Array.isArray(full.line_items) ? full.line_items : [];
    const matchedLines = [];
    const unmatchedLines = [];
    for (const line of lines) {
      const product = findLocalProduct(line);
      if (product) matchedLines.push({ line, product });
      else unmatchedLines.push(line);
    }

    plans.push({
      id, full, localRef, existing, customer, matchedBy, matchedLines, unmatchedLines,
      skip: Boolean(existing) || !customer
    });
  }

  console.log(pad('SALES ORDER', 14) + pad('ZOHO STATUS', 13) + pad('CUSTOMER', 30) + pad('LINES', 9) + 'ACTION');
  console.log('─'.repeat(96));
  for (const p of plans) {
    const action = p.existing
      ? `already here (${p.existing.getmeds_order_id})`
      : !p.customer
        ? '✗ SKIP — customer not in local DB'
        : `import as ${p.localRef}`;
    console.log(
      pad(p.full.salesorder_number || p.id, 14) +
      pad(p.full.status || '?', 13) +
      pad((p.full.customer_name || '').slice(0, 28), 30) +
      pad(`${p.matchedLines.length}/${p.matchedLines.length + p.unmatchedLines.length}`, 9) +
      action
    );
  }

  const importable = plans.filter((p) => !p.skip);
  const unmatchedCustomers = plans.filter((p) => !p.customer && !p.existing);
  if (unmatchedCustomers.length) {
    console.log(
      `\n${unmatchedCustomers.length} order(s) reference a Zoho contact this database doesn't have. ` +
        'Run the customer sync from the Clients page first, then re-run this.'
    );
  }
  const anyUnmatchedLines = importable.some((p) => p.unmatchedLines.length);
  if (anyUnmatchedLines) {
    console.log(
      '\nSome line items have no matching local product. They are recorded in the order notes ' +
        'rather than invented as products — the order total still comes from Zoho, so money is never wrong.'
    );
  }

  if (!confirmed) {
    console.log(`\nDry run — nothing written. Re-run with --yes to import ${importable.length} order(s).\n`);
    process.exit(0);
  }

  if (!importable.length) {
    console.log('\nNothing to import.\n');
    process.exit(0);
  }

  console.log(`\nImporting ${importable.length} order(s)…\n`);

  for (const p of importable) {
    const f = p.full;
    const total = Number(f.total ?? 0);
    const address =
      f.shipping_address?.address || f.billing_address?.address || p.customer.address || 'See Zoho';
    const noteBits = [`Adopted from Zoho Sales Order ${f.salesorder_number || p.id}. Not raised in this app.`];
    if (p.unmatchedLines.length) {
      noteBits.push(
        `Line items with no local product match: ${p.unmatchedLines.map((l) => `${l.name} x${l.quantity}`).join('; ')}.`
      );
    }

    const orderId = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO orders (
          getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
          delivery_address, delivery_notes, sales_order_date,
          zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status,
          created_at, submitted_at, updated_at
        ) VALUES (?, ?, ?, 'so_created', ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)
      `).run(
        p.localRef, p.customer.id, actor.id,
        p.customer.type === 'credit' ? 'credit' : 'direct',
        total, address, noteBits.join(' '),
        f.date || new Date().toISOString().slice(0, 10),
        String(p.id), f.salesorder_number || null,
        f.status ? String(f.status).toLowerCase() : 'draft',
        new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      );
      const newId = inserted.lastInsertRowid;

      for (const { line, product } of p.matchedLines) {
        const qty = Number(line.quantity) || 1;
        const rate = Number(line.rate) || 0;
        const subtotal = qty * rate;
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(newId, product.id, qty, rate, subtotal, Number(line.item_total ?? subtotal));
      }

      db.prepare(`
        INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata)
        VALUES (?, 'ORDER_IMPORTED_FROM_ZOHO', NULL, 'so_created', ?, ?, ?, ?)
      `).run(
        newId, actor.id, `${actor.name} (Zoho import)`,
        `Imported from Zoho Sales Order ${f.salesorder_number || p.id}. This order was created in Zoho, not in this app.`,
        JSON.stringify({ zohoSoId: String(p.id), zohoSoNumber: f.salesorder_number, source: 'zoho_import' })
      );

      return newId;
    })();

    // Rebuild the trail from Zoho's own record — confirmed, invoiced, sent,
    // packed, shipped, paid. reconcileOrderFully because each pass records
    // exactly one checkpoint.
    const result = await reconcileOrderFully({
      orderId,
      actorId: actor.id,
      actorName: `${actor.name} (Zoho import)`,
      source: 'zoho_import'
    });

    const finalStatus = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status;
    console.log(
      `  ${pad(f.salesorder_number || p.id, 14)} → ${pad(p.localRef, 20)} ${pad(finalStatus, 24)} ` +
      `${result.actions?.length ? result.actions.join(' → ') : 'no further checkpoints in Zoho'}`
    );
  }

  console.log('\n✅ Done. Open the Orders list — each imported order carries the trail Zoho knows about.\n');
})();
