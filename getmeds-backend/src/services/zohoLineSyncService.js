const db = require('../db/database');
const { computeLine } = require('./lineAmounts');
const { hasColumn } = require('./schemaColumns');
const { isImportedRef } = require('./orderOrigin');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');

/**
 * Sep 22, 2026: split-invoicing orders — this whole file predates that
 * feature and was built on "one order = one Sales Order = the whole item
 * list." That stopped being true the moment order_items could carry a
 * per-line `invoicing_from` override (see orderSplitService.js): a split
 * order's local items now span TWO Sales Orders, and syncing either one's
 * lines must only touch that entity's own slice — never the whole table.
 *
 * Found the hard way on TestGM-20260922-0001: syncing the primary's Sales
 * Order deleted the split's item, and syncing the split's Sales Order
 * deleted the primary's — each sync correctly reflected ONE Sales Order,
 * but each one WAS treated as if it were the entire order, so line items
 * ping-ponged in and out of existence depending on whichever Sales Order's
 * webhook/reconcile pull ran last.
 */

/**
 * Bring an order's LINE ITEMS and TOTAL into line with its Zoho Sales Order.
 *
 * Sep 14, 2026. When someone edits a Sales Order in Zoho, this app notices —
 * the `salesorder.edited` webhook fires, and "Sync from Zoho" reconciles on
 * demand — but both compared only seven header fields (Payment Terms,
 * Invoicing From, Doctor, Source, Delivery Method, Terms, Salesperson). Line
 * items and the total were never compared or written.
 *
 * GM-20260913-0001 surfaced it. Zoho's own history, copied into the trail,
 * read "Amount changed from PHP6,973.08 to PHP5,440.00" — and the order still
 * showed PHP 6,973.08, with a product (Carboplatin 450) Zoho had already
 * swapped for another (CarboGet 450), and without a line Zoho had added. The
 * trail said it changed; the order said it had not.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * Replaces the order's items with Zoho's lines and sets the total to what Zoho
 * will bill. Idempotent: an order already matching Zoho is left alone and
 * nothing is logged, so it is safe on every webhook and every sync.
 *
 * ── What it refuses to do, and why ────────────────────────────────────────
 *
 *   - Use a Sales Order missing a rate on any line, or its total. Real Zoho
 *     always sends both; a response without them is partial, and syncing from
 *     it would zero out prices. (The test mock builds exactly such orders.)
 *
 *   - Replace items when any line cannot be STORED — no matching product, or a
 *     quantity that is not a whole number (order_items.quantity is an INTEGER).
 *     A partial replace would silently drop a line and keep a total that no
 *     longer adds up, and a bad quantity would abort the whole transaction. It
 *     logs why instead, once per distinct problem.
 *
 *   - Touch an order imported FROM Zoho (ZOHO-…). Those are 60,000-odd rows of
 *     history, and the import enrichment reconciles them in bulk — a line
 *     rewrite there would be a mass production write nobody asked for.
 *
 * Returns what it did: 'unchanged' | 'synced' | 'refused' | 'skipped'.
 */

const money = (n) =>
  `PHP ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A Zoho line's discount as an amount, whether Zoho gave an amount or "10%". */
function lineDiscount(line, subtotal) {
  if (line.discount_amount != null && line.discount_amount !== '') return Math.max(0, Number(line.discount_amount) || 0);
  const d = line.discount;
  if (typeof d === 'string' && d.trim().endsWith('%')) {
    return Math.max(0, (subtotal * (parseFloat(d) || 0)) / 100);
  }
  return Math.max(0, Number(d) || 0);
}

async function findProduct(line) {
  if (line.item_id) {
    const p = await db.prepare('SELECT * FROM products WHERE zoho_item_id = ?').get(String(line.item_id));
    if (p) return p;
  }
  if (line.sku) {
    const p = await db.prepare('SELECT * FROM products WHERE LOWER(sku) = LOWER(?) LIMIT 1').get(String(line.sku));
    if (p) return p;
  }
  if (line.name) {
    const p = await db.prepare('SELECT * FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1').get(String(line.name));
    if (p) return p;
  }
  return null;
}

/** One comparable string per line, sorted, so the order of lines does not matter. */
function signature(rows) {
  return rows
    .map((r) => [
      r.product_id,
      Number(r.quantity),
      Number(r.unit_price).toFixed(2),
      Number(r.discount_amount || 0).toFixed(2),
      Number(r.tax_percent || 0).toFixed(2)
    ].join('|'))
    .sort()
    .join(';');
}

const hasNumber = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

/**
 * `invoicingFrom` — omitted (or null), this syncs the PRIMARY entity's slice
 * of order_items (exactly this function's whole behavior before splits
 * existed). A value scopes every read/delete/insert below to that split
 * entity's own rows instead, and stamps `invoicing_from` on what it inserts
 * so the tag survives a re-sync. Callers pass this whenever the `salesorder`
 * they are handing in is a SPLIT's own Sales Order, not the order's primary
 * one — see webhook.controller.js's handleSplitWebhookEvent and
 * services/orderSplitService.js.
 */
async function syncLineItemsFromZoho({ order: given, salesorder, actorName = 'Zoho', invoicingFrom = null }) {
  if (!given || !salesorder) return 'skipped';

  // Re-read the row: callers hold differently-shaped order objects (the
  // webhook's lookup and reconcile's join select different columns), and this
  // compares against the stored total and items, so it needs the real row.
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(given.id);
  if (!order || isImportedRef(order.getmeds_order_id)) return 'skipped';

  // A split-scoped sync needs order_items.invoicing_from to know which rows
  // are "this entity's" — without it (an unmigrated environment) there is no
  // safe way to scope the delete+insert, so refuse rather than guess.
  const canScopeByEntity = await hasColumn('order_items', 'invoicing_from');
  if (invoicingFrom && !canScopeByEntity) {
    console.warn(`[ZOHO_LINE_SYNC] order ${order.id}: cannot sync ${invoicingFrom}'s items — order_items.invoicing_from is missing (run the migration).`);
    return 'skipped';
  }
  const entityFilterSql = canScopeByEntity ? (invoicingFrom ? 'AND oi.invoicing_from = ?' : 'AND oi.invoicing_from IS NULL') : '';
  const entityFilterParams = canScopeByEntity && invoicingFrom ? [invoicingFrom] : [];

  const lines = Array.isArray(salesorder.line_items) ? salesorder.line_items : [];
  // Never empty an order, and never sync from a partial response.
  if (!lines.length || !hasNumber(salesorder.total) || !lines.every((l) => hasNumber(l.rate))) return 'skipped';

  const inclusive = Boolean(salesorder.is_inclusive_tax);
  const incoming = [];
  const problems = [];

  for (const line of lines) {
    const label = line.name || line.sku || line.item_id;
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      problems.push(`${label} has a quantity of ${line.quantity}, and this app stores only whole-number quantities`);
      continue;
    }
    const product = await findProduct(line);
    if (!product) {
      problems.push(`${label} has no matching product here`);
      continue;
    }

    const unitPrice = Number(line.rate);
    const subtotal = quantity * unitPrice;
    const { discountAmount, taxPercent, lineTotal } = computeLine({
      subtotal,
      discount: lineDiscount(line, subtotal),
      taxPercent: line.tax_percentage,
      inclusive
    });
    incoming.push({
      product_id: product.id,
      name: product.name,
      quantity,
      unit_price: unitPrice,
      subtotal,
      discount_amount: discountAmount,
      tax_percent: taxPercent,
      tax_label: line.tax_name || null,
      line_total: lineTotal
    });
  }

  if (problems.length) {
    const summary = problems.join('; ');
    // Once per distinct problem, so a webhook that fires repeatedly does not
    // flood the trail with the same warning. Scoped by entity too — a
    // problem on the split's items must not be deduped away by an unrelated
    // one already logged for the primary, or vice versa.
    const already = await db
      .prepare("SELECT 1 FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_ITEMS_NOT_SYNCED' AND notes LIKE ?")
      .get(order.id, `%${summary}%`);
    if (!already) {
      await logEvent({
        orderId: order.id,
        eventType: 'ZOHO_SO_ITEMS_NOT_SYNCED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: null,
        actorName,
        notes:
          `${invoicingFrom ? `[${invoicingFrom}] ` : ''}The Sales Order's items could not be copied from Zoho, so they were left as they were rather than ` +
          `stored incomplete: ${summary}. If a product is missing, run "Pull from Zoho" on the inventory page, ` +
          'then Sync from Zoho on this order.',
        metadata: { problems, invoicingFrom: invoicingFrom || null }
      });
    }
    return 'refused';
  }

  // Sep 22, 2026: scoped to just this entity's own rows — the other
  // entity's items (if any) are left completely untouched below.
  const current = await db
    .prepare(
      `SELECT oi.product_id, oi.quantity, oi.unit_price, oi.discount_amount, oi.tax_percent, oi.line_total, p.name
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ${entityFilterSql}`
    )
    .all(order.id, ...entityFilterParams);

  const zohoTotal = Number(salesorder.total);
  const sameLines = signature(current) === signature(incoming);
  // Compared against THIS entity's own current slice, not the order's
  // blended total — for a split order, order.total_amount spans every
  // entity and is never equal to any one Sales Order's own total.
  const currentSliceTotal = current.reduce((s, r) => s + Number(r.line_total || 0), 0);
  const sameTotal = Math.abs(currentSliceTotal - zohoTotal) < 0.005;
  if (sameLines && sameTotal) return 'unchanged';

  const describe = (rows) =>
    rows.map((r) => `${Number(r.quantity)}x ${r.name || 'item'} @ ${money(r.unit_price)}`).join('; ') || 'none';
  const lineSum = incoming.reduce((s, r) => s + r.line_total, 0);

  let orderTotal = Number(order.total_amount || 0);

  await db.transaction(async () => {
    await db.prepare(`DELETE FROM order_items oi WHERE oi.order_id = ? ${entityFilterSql}`).run(order.id, ...entityFilterParams);
    const insertColumns = ['order_id', 'product_id', 'quantity', 'unit_price', 'subtotal', 'discount_amount', 'tax_percent', 'tax_label', 'line_total'];
    if (canScopeByEntity) insertColumns.push('invoicing_from');
    const ins = db.prepare(
      `INSERT INTO order_items (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`
    );
    for (const r of incoming) {
      const values = [order.id, r.product_id, r.quantity, r.unit_price, r.subtotal, r.discount_amount, r.tax_percent, r.tax_label, r.line_total];
      if (canScopeByEntity) values.push(invoicingFrom || null);
      await ins.run(...values);
    }

    // Sep 22, 2026: the ORDER's total is the sum across every entity's
    // items now, not just the slice this call just synced — for a
    // non-split order every row belongs to the primary, so this is the
    // same number `zohoTotal` always was. For a split order, no single
    // Sales Order's total represents the whole GetMeds order any more.
    const allItems = await db.prepare('SELECT line_total FROM order_items WHERE order_id = ?').all(order.id);
    orderTotal = allItems.reduce((s, r) => s + Number(r.line_total || 0), 0);
    await db.prepare('UPDATE orders SET total_amount = ?, updated_at = ? WHERE id = ?')
      .run(orderTotal, new Date().toISOString(), order.id);
    // Guarded: inside this transaction a statement on a missing column would
    // abort everything above — see services/schemaColumns.js.
    if (await hasColumn('orders', 'is_inclusive_tax')) {
      await db.prepare('UPDATE orders SET is_inclusive_tax = ? WHERE id = ?').run(inclusive ? 1 : 0, order.id);
    }

    await logEvent({
      orderId: order.id,
      eventType: 'ZOHO_SO_ITEMS_SYNCED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: null,
      actorName,
      notes:
        `Items updated from Zoho (${salesorder.salesorder_number || order.zoho_so_number || 'Sales Order'})` +
        `${invoicingFrom ? ` for ${invoicingFrom}` : ''}. ` +
        `Was: ${describe(current)}. Now: ${describe(incoming)}. ` +
        `Order total ${money(order.total_amount)} → ${money(orderTotal)}.`,
      metadata: {
        invoicingFrom: invoicingFrom || null,
        before: current.map((r) => ({ product_id: r.product_id, quantity: Number(r.quantity), unit_price: Number(r.unit_price) })),
        after: incoming.map((r) => ({ product_id: r.product_id, quantity: r.quantity, unit_price: r.unit_price, line_total: r.line_total })),
        totalBefore: Number(order.total_amount || 0),
        totalAfter: orderTotal,
        lineSum,
        ...(Math.abs(lineSum - zohoTotal) >= 0.01
          ? { note: 'Line totals differ from the Zoho total, most likely an order-level discount in Zoho.' }
          : {})
      }
    });
  })();

  const financeIds = await getUserIdsByRole('finance');
  await notify({
    orderId: order.id,
    recipientIds: Array.from(new Set([order.medrep_id, ...financeIds].filter(Boolean))),
    message: `Order ${order.getmeds_order_id}${invoicingFrom ? ` (${invoicingFrom})` : ''} — items changed in Zoho; total now ${money(orderTotal)}.`,
    eventType: 'ZOHO_SO_ITEMS_SYNCED',
    orderData: { ...order, total_amount: orderTotal }
  });

  return 'synced';
}

module.exports = { syncLineItemsFromZoho };
