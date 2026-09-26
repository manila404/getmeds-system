'use strict';

/**
 * Pull a split order's SECOND Zoho Sales Order back into GetMeds — Sep 26, 2026.
 *
 * A split-invoicing order is one GetMeds order and two Zoho Sales Orders (see
 * orderSplitService.js). "Sync from Zoho", the background poller and the
 * refresh-on-open all ran zohoReconcileService.reconcileOrder, which reads
 * orders.zoho_so_id, the PRIMARY Sales Order, and nothing else. So the second one
 * only ever changed when a Zoho webhook happened to reach the app: GM-20260926-0013's
 * SO-67982 was invoiced and shipped in Zoho, gained two lines Finance added there, and
 * GetMeds showed none of it.
 *
 * For every split row this now reads its Sales Order from Zoho and brings in:
 *   - its items and their total, through the same line sync the primary uses, scoped
 *     to that entity's own lines (so the order total is recomputed across both)
 *   - its status, invoice (number and stage), payment, package and shipment,
 *     each written to order_split_sales_orders, and logged to the order's trail once
 *     when it first changes, tagged with the entity
 *
 * Idempotent: nothing is written or logged when Zoho and the row already agree.
 * Never throws: a Zoho failure on one Sales Order is reported and the next one still runs.
 * It never changes the order's own `status`; that stays with the primary path and the
 * split-aware completion rule.
 */

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent } = require('./auditService');
const { syncLineItemsFromZoho } = require('./zohoLineSyncService');
const { isImportedRef } = require('./orderOrigin');

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** Pure: what a Zoho Sales Order says about the parts of a split row we track. */
function deriveSplitState(salesorder) {
  const raw = lc(salesorder && salesorder.status);
  const soStatus = ['void', 'voided', 'cancelled', 'canceled'].includes(raw) ? 'cancelled' : raw === 'draft' || !raw ? 'draft' : 'confirmed';

  const invoices = Array.isArray(salesorder && salesorder.invoices) ? salesorder.invoices.filter((i) => lc(i.status) !== 'void') : [];
  const inv = invoices.length ? invoices[invoices.length - 1] : null;
  const invStatus = inv ? lc(inv.status) : null;
  const invoice = inv
    ? {
        id: inv.invoice_id || null,
        number: inv.invoice_number || null,
        stage: invStatus === 'draft' ? 'draft' : 'sent',
        paid: ['paid', 'closed'].includes(invStatus),
      }
    : null;

  const packages = Array.isArray(salesorder && salesorder.packages) ? salesorder.packages : [];
  const pkg = packages.length ? packages[packages.length - 1] : null;
  const shipmentInfo = pkg && pkg.shipment_order;
  const shipped =
    ['shipped', 'delivered', 'fulfilled'].includes(lc(pkg && (pkg.shipment_status || pkg.status))) ||
    ['shipped', 'partially_shipped', 'fulfilled'].includes(lc(salesorder && salesorder.shipped_status));

  return {
    soStatus,
    invoice,
    package: pkg ? { id: pkg.package_id || null, number: pkg.package_number || null } : null,
    shipped,
    shipment: shipmentInfo ? { id: shipmentInfo.shipment_id || null, number: shipmentInfo.shipment_number || null } : null,
  };
}

async function reconcileOneSplit(order, split, { actorName, source }) {
  const entity = split.invoicing_from;
  const out = { invoicing_from: entity, zoho_so_number: split.zoho_so_number, changes: [], items: null, error: null };
  const syncMeta = { source, syncedBy: actorName, invoicingFrom: entity, splitId: split.id };
  const now = new Date().toISOString();
  const log = (eventType, notes, extra = {}) =>
    logEvent({ orderId: order.id, eventType, actorName: 'Zoho', notes: `[${entity}] ${notes}`, metadata: { ...syncMeta, ...extra } });

  let salesorder;
  try {
    salesorder = (await zoho.getSalesOrder(split.zoho_so_id)).salesorder;
  } catch (err) {
    const gone = err && (err.httpStatus === 404 || (err.zohoResponse && err.zohoResponse.code === 5) || lc(err.message).includes('does not exist'));
    if (gone) {
      await db.prepare("UPDATE order_split_sales_orders SET zoho_so_status = 'deleted', updated_at = ? WHERE id = ?").run(now, split.id);
      await log('ZOHO_SO_DELETED', 'Sales Order no longer exists in Zoho: it was deleted there.');
      out.changes.push('deleted');
    } else {
      out.error = `Could not reach Zoho: ${err.message}`;
    }
    return out;
  }
  if (!salesorder) {
    out.error = 'Zoho returned no Sales Order.';
    return out;
  }

  const s = deriveSplitState(salesorder);

  // Sales Order status
  if (s.soStatus !== split.zoho_so_status) {
    await db.prepare('UPDATE order_split_sales_orders SET zoho_so_status = ?, updated_at = ? WHERE id = ?').run(s.soStatus, now, split.id);
    if (s.soStatus === 'confirmed') await log('ZOHO_SO_CONFIRMED', 'Sales Order confirmed in Zoho.');
    else if (s.soStatus === 'cancelled') await log('ZOHO_SO_CANCELLED', 'Sales Order voided/cancelled in Zoho.');
    out.changes.push(`status ${s.soStatus}`);
  }

  // Invoice: number and stage, then payment
  if (s.invoice) {
    const stage = s.invoice.stage;
    if (split.zoho_invoice_id !== s.invoice.id || split.zoho_invoiced_status !== stage) {
      await db
        .prepare('UPDATE order_split_sales_orders SET zoho_invoice_id = ?, zoho_invoice_number = ?, zoho_invoiced_status = ?, updated_at = ? WHERE id = ?')
        .run(s.invoice.id, s.invoice.number, stage, now, split.id);
      await log(
        stage === 'draft' ? 'ZOHO_INVOICE_DRAFTED' : 'ZOHO_INVOICE_SENT',
        `Invoice ${s.invoice.number || ''} ${stage === 'draft' ? 'drafted' : 'sent'} in Zoho.`.replace('  ', ' '),
        { zohoInvoiceId: s.invoice.id }
      );
      out.changes.push(`invoice ${s.invoice.number || ''}`.trim());
    }
    if (s.invoice.paid && split.zoho_paid_status !== 'paid') {
      await db.prepare("UPDATE order_split_sales_orders SET zoho_paid_status = 'paid', updated_at = ? WHERE id = ?").run(now, split.id);
      await log('ZOHO_PAYMENT_VERIFIED', `Invoice ${s.invoice.number || ''} is paid in Zoho.`.replace('  ', ' '));
      out.changes.push('paid');
    }
  }

  // Package
  if (s.package && s.package.id && split.zoho_package_id !== s.package.id) {
    await db
      .prepare('UPDATE order_split_sales_orders SET zoho_package_id = ?, zoho_package_number = ?, updated_at = ? WHERE id = ?')
      .run(s.package.id, s.package.number, now, split.id);
    if (!split.zoho_package_id) await log('ZOHO_PACKAGE_CREATED', `Package ${s.package.number || ''} created in Zoho.`.replace('  ', ' '), { zohoPackageId: s.package.id });
    out.changes.push('package');
  }

  // Shipment
  if (s.shipped && split.zoho_shipped_status !== 'shipped') {
    await db
      .prepare(
        `UPDATE order_split_sales_orders
            SET zoho_shipped_status = 'shipped', zoho_shipment_id = COALESCE(?, zoho_shipment_id),
                zoho_shipment_number = COALESCE(?, zoho_shipment_number), updated_at = ? WHERE id = ?`
      )
      .run(s.shipment ? s.shipment.id : null, s.shipment ? s.shipment.number : null, now, split.id);
    await log('ZOHO_DISPATCHED', 'Shipment recorded in Zoho for this Sales Order.');
    out.changes.push('shipped');
  }

  // Items and total, scoped to this entity's own lines.
  try {
    out.items = await syncLineItemsFromZoho({ order, salesorder, actorName: 'Zoho', invoicingFrom: entity });
    if (out.items === 'synced') out.changes.push('items');
  } catch (err) {
    out.items = 'failed';
    out.error = `Items not synced: ${err.message}`;
  }
  return out;
}

/**
 * Reconcile every split Sales Order of an order. Returns { splits: [...], changed }.
 * A non-split order costs one query and returns { splits: [], changed: false }.
 */
async function reconcileSplitOrders({ orderId, actorName = 'Auto Sync', source = 'auto_sync' }) {
  try {
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || isImportedRef(order.getmeds_order_id)) return { splits: [], changed: false };

    const splits = await db
      .prepare("SELECT * FROM order_split_sales_orders WHERE order_id = ? AND zoho_so_id IS NOT NULL AND COALESCE(zoho_so_status, '') <> 'deleted' ORDER BY id")
      .all(orderId);
    if (!splits.length) return { splits: [], changed: false };

    const results = [];
    for (const split of splits) {
      // Re-read the order each time: the previous split's item sync changed its total.
      const fresh = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      try {
        results.push(await reconcileOneSplit(fresh, split, { actorName, source }));
      } catch (err) {
        console.error(`[ZOHO_SPLIT_RECONCILE] order ${orderId} (${split.invoicing_from}) failed:`, err.message);
        results.push({ invoicing_from: split.invoicing_from, zoho_so_number: split.zoho_so_number, changes: [], items: null, error: err.message });
      }
    }
    return { splits: results, changed: results.some((r) => r.changes.length > 0) };
  } catch (err) {
    console.error(`[ZOHO_SPLIT_RECONCILE] order ${orderId} failed:`, err.message);
    return { splits: [], changed: false, error: err.message };
  }
}

module.exports = { reconcileSplitOrders, deriveSplitState };
