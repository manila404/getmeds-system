'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { isDryRunMode } = require('./zohoTestFlags');
const { logEvent } = require('./auditService');

/**
 * Split-invoicing orders: one GetMeds order, two Zoho Sales Orders.
 *
 * Sep 22, 2026. `orders.zoho_so_id`/`zoho_so_number`/`zoho_so_status`/
 * `zoho_invoice_id`/`zoho_invoice_number` and the four Zoho status-axis
 * columns stay exactly what they've always been — one Sales Order per order
 * row, read and written in dozens of places against 60,000+ existing
 * orders. This module does NOT touch any of that. It is the narrow,
 * additive piece that exists only for the rare order where a line item was
 * explicitly set to the OTHER `invoicing_from` entity: it groups an order's
 * items into "the primary entity's" (unchanged — still flows through every
 * existing orders-column code path) and "the other entity's" (new — lives
 * in order_split_sales_orders instead).
 *
 * An order with no split items never calls anything in this file that
 * writes anything: `groupItemsByInvoicingFrom` returns `splitItems: null`
 * and every caller is expected to skip straight to its existing,
 * unmodified single-Sales-Order path.
 */

const INVOICING_FROM_VALUES = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

/**
 * Splits a resolved-items array into the order's PRIMARY entity (whatever
 * the order's own top-level `invoicing_from` holds) and, if any line names
 * the OTHER entity, that entity's items.
 *
 * Each item needs at least `invoicing_from` (may be null/undefined —
 * "follow the order") and whatever shape the caller otherwise uses.
 *
 * Returns `{ primaryItems, splitItems, splitInvoicingFrom }`. `splitItems`/
 * `splitInvoicingFrom` are `null` together whenever every item follows the
 * order — callers should branch on `if (splitItems)`, not a length check,
 * so "no split" reads the same whether there were 1 or 50 items.
 *
 * An item naming a value that isn't one of the two known entities (should
 * already be rejected by validation before this runs) is treated as
 * "follow the order" rather than silently dropped from both groups.
 */
function groupItemsByInvoicingFrom(items, orderInvoicingFrom) {
  const primaryItems = [];
  const splitItems = [];
  let splitInvoicingFrom = null;

  for (const item of items) {
    const itemEntity = item.invoicing_from || null;
    const isSplitLine =
      itemEntity &&
      INVOICING_FROM_VALUES.includes(itemEntity) &&
      itemEntity !== orderInvoicingFrom;

    if (isSplitLine) {
      splitItems.push(item);
      splitInvoicingFrom = itemEntity;
    } else {
      primaryItems.push(item);
    }
  }

  return {
    primaryItems,
    splitItems: splitItems.length ? splitItems : null,
    splitInvoicingFrom: splitItems.length ? splitInvoicingFrom : null
  };
}

/**
 * The split rows an order already has, keyed by invoicing_from for easy
 * lookup ({ '2mg Incorporated': row, ... }).
 */
async function getSplitsForOrder(orderId) {
  const rows = await db.prepare('SELECT * FROM order_split_sales_orders WHERE order_id = ?').all(orderId);
  const byEntity = {};
  for (const row of rows) byEntity[row.invoicing_from] = row;
  return { rows, byEntity };
}

/**
 * Sep 22, 2026: the split's own dry-run fabrication — mirrors
 * orders.controller.js's buildDryRunSalesOrder exactly (same fields the
 * rest of this app reads: salesorder_id, salesorder_number, line_items,
 * ...), but suffixed so a dry-run primary and its dry-run split never
 * collide on the same fake id. Kept here rather than importing
 * orders.controller.js's version — that file requires this one, and going
 * back the other way risks a real circular require for no reason worth it.
 */
function buildDryRunSplitSalesOrder(payload, invoicingFrom) {
  const fakeId = `DRYRUN-${payload.getmeds_order_id}-${invoicingFrom.replace(/\s+/g, '')}`;
  return {
    code: 0,
    message: 'Sales order NOT sent to Zoho — ZOHO_DRY_RUN is enabled',
    salesorder: {
      salesorder_id: fakeId,
      salesorder_number: fakeId,
      status: 'draft',
      customer_id: payload.zoho_customer_id || null,
      customer_name: payload.customer_name,
      total: payload.total_amount,
      reference_number: payload.getmeds_order_id,
      notes: `[DRY RUN — nothing was sent to Zoho] Order No.: ${payload.getmeds_order_id} (${invoicingFrom})`,
      date: new Date().toISOString().slice(0, 10),
      line_items: (payload.items || []).map((item) => ({
        item_id: item.zoho_item_id || null,
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price,
        item_total: item.subtotal
      })),
      created_time: new Date().toISOString(),
      _dry_run: true
    }
  };
}

/**
 * Creates the split entity's own Zoho Sales Order and records it in
 * order_split_sales_orders — the split's exact counterpart to
 * `zoho.createSalesOrder(primaryPayload)` + the write onto `orders.zoho_so_id`
 * that every existing call site already does for the primary.
 *
 * `primaryPayload` is whatever full payload the caller already built for
 * the primary entity (create()'s or syncOrderToZohoAndFinalize()'s own
 * zohoPayload) — this clones it and swaps in the split's own items/entity
 * rather than re-deriving every field (customer, delivery address, terms,
 * salesperson, division, etc.) a second time.
 *
 * Never throws: a failure is recorded on the row (`zoho_sync_status:
 * 'failed'`) and queued via `zohoRetryService.enqueue` with this entity's
 * name, the same fail-safe-not-fail-closed shape orders.controller.js
 * already uses for the primary — one entity's Zoho outage blocks neither
 * the other entity's Sales Order nor the order being created at all.
 */
async function createSplitSalesOrder({ orderId, getmedsOrderId, primaryPayload, splitItems, splitInvoicingFrom }) {
  // Required lazily — zohoRetryService requires this file (via
  // zohoPayloadBuilder's split-aware rebuild), so a top-level require here
  // would be circular.
  const zohoRetryService = require('./zohoRetryService');

  const now = new Date().toISOString();
  const splitPayload = { ...primaryPayload, items: splitItems, invoicing_from: splitInvoicingFrom };

  let zohoResult = null;
  let zohoError = null;
  let dryRun = false;
  if (isDryRunMode()) {
    // ZOHO_DRY_RUN=true — no HTTP call to Zoho is made at all, same
    // guarantee orders.controller.js's own dry-run branch gives the
    // primary. Without this, a split order under dry run would still make
    // one REAL Zoho call for its second entity even while the primary
    // correctly makes none.
    zohoResult = buildDryRunSplitSalesOrder(splitPayload, splitInvoicingFrom);
    dryRun = true;
  } else {
    try {
      zohoResult = await zoho.createSalesOrder(splitPayload);
    } catch (err) {
      zohoError = err.message;
      console.error(
        `[ORDER_SPLIT] createSalesOrder failed for ${getmedsOrderId} (${splitInvoicingFrom}) — order still created, queued for retry:`,
        err.message
      );
    }
  }

  const inserted = await db
    .prepare(
      `INSERT INTO order_split_sales_orders (
         order_id, invoicing_from, zoho_so_id, zoho_so_number, zoho_so_status,
         zoho_sync_status, zoho_sync_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      orderId,
      splitInvoicingFrom,
      zohoResult ? zohoResult.salesorder.salesorder_id : null,
      zohoResult ? zohoResult.salesorder.salesorder_number : null,
      zohoResult ? (zohoResult.salesorder.status || 'draft') : null,
      zohoResult ? (dryRun ? 'skipped' : 'synced') : 'failed',
      zohoError,
      now,
      now
    );

  if (!zohoResult) {
    await zohoRetryService.enqueue({
      orderId,
      payload: splitPayload,
      error: zohoError,
      invoicingFrom: splitInvoicingFrom
    });
  }

  return { splitId: inserted.lastInsertRowid, zohoResult, zohoError };
}

/**
 * Sep 22, 2026: pushes ONE physical pack/ship action (per the business
 * decision — Dispatch enters one tracking number in GetMeds, not two) onto
 * every split entity's OWN Sales Order in Zoho, in addition to whatever
 * workflowV2Service.markPacked/.ship already did for the primary. Zoho
 * itself has no concept of "one shipment across two Sales Orders" — each
 * one needs its own package and its own shipment record — so this is what
 * makes that invisible to Dispatch: they press one button, and every
 * entity behind the order gets its own Zoho package/shipment with the same
 * date/courier/tracking number.
 *
 * `kind` is 'pack' or 'ship'. Never throws: one entity's Zoho failure is
 * logged and recorded on that split row, exactly like the primary's own
 * fail-safe-not-fail-closed pattern — it never blocks the other entity or
 * undoes what workflowV2Service already committed for the primary.
 */
async function pushDispatchActionToSplits({ orderId, kind, actor, dryRun, date, courier, trackingNumber }) {
  const { rows: splits } = await getSplitsForOrder(orderId);
  const results = [];
  const now = new Date().toISOString();

  for (const split of splits) {
    if (!split.zoho_so_id) {
      results.push({ invoicingFrom: split.invoicing_from, skipped: true, reason: 'no Sales Order yet' });
      continue;
    }
    try {
      if (kind === 'pack') {
        if (split.zoho_package_id) { results.push({ invoicingFrom: split.invoicing_from, skipped: true, reason: 'already packed' }); continue; }
        let pkg;
        if (dryRun) {
          pkg = { package_id: `DRYRUN-PKG-${orderId}-${split.invoicing_from.replace(/\s+/g, '')}`, package_number: `DRYRUN-PKG-${orderId}-${split.invoicing_from.replace(/\s+/g, '')}` };
        } else {
          const soRes = await zoho.getSalesOrder(split.zoho_so_id);
          const so = soRes && soRes.salesorder;
          const existing = (so?.packages || [])[0];
          pkg = existing || (await zoho.createPackageForSalesOrder(so, { date })).package;
        }
        await db.prepare(`UPDATE order_split_sales_orders SET zoho_package_id = ?, zoho_package_number = ?, updated_at = ? WHERE id = ?`)
          .run(pkg.package_id, pkg.package_number || null, now, split.id);
        await logEvent({
          orderId, eventType: 'ZOHO_PACKAGE_CREATED', actorId: actor.id, actorName: actor.name,
          notes: `[${split.invoicing_from}] Package ${pkg.package_number || ''} created from GetMeds${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
          metadata: { invoicingFrom: split.invoicing_from, splitId: split.id, zohoPackageId: pkg.package_id, source: 'getmeds', dryRun }
        });
        results.push({ invoicingFrom: split.invoicing_from, packageNumber: pkg.package_number || null });
      } else {
        if (split.zoho_shipment_id) { results.push({ invoicingFrom: split.invoicing_from, skipped: true, reason: 'already shipped' }); continue; }
        if (!split.zoho_package_id) { results.push({ invoicingFrom: split.invoicing_from, skipped: true, reason: 'not packed yet' }); continue; }
        let shipment;
        if (dryRun) {
          shipment = { shipment_id: `DRYRUN-SHP-${orderId}-${split.invoicing_from.replace(/\s+/g, '')}`, shipment_number: `SH-${orderId}-${split.invoicing_from.replace(/\s+/g, '')}` };
        } else {
          const created = await zoho.createShipmentForPackage({
            salesorderId: split.zoho_so_id, packageId: split.zoho_package_id,
            shipmentNumber: `SH-${orderId}-${split.invoicing_from.replace(/\s+/g, '')}`,
            date, deliveryMethod: courier, trackingNumber
          });
          shipment = created.shipmentorder;
        }
        await db.prepare(`UPDATE order_split_sales_orders SET zoho_shipment_id = ?, zoho_shipment_number = ?, zoho_shipped_status = 'shipped', updated_at = ? WHERE id = ?`)
          .run(shipment.shipment_id, shipment.shipment_number || null, now, split.id);
        await logEvent({
          orderId, eventType: 'ZOHO_DISPATCHED', actorId: actor.id, actorName: actor.name,
          notes: `[${split.invoicing_from}] Shipped via ${courier}, tracking ${trackingNumber} — same physical parcel as the order's own shipment${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
          metadata: { invoicingFrom: split.invoicing_from, splitId: split.id, zohoShipmentId: shipment.shipment_id, courier, trackingNumber, source: 'getmeds', dryRun }
        });
        results.push({ invoicingFrom: split.invoicing_from, shipmentNumber: shipment.shipment_number || null });
      }
    } catch (err) {
      console.error(`[ORDER_SPLIT] ${kind} failed for ${split.invoicing_from} on order ${orderId}:`, err.message);
      await db.prepare(`UPDATE order_split_sales_orders SET zoho_sync_error = ?, updated_at = ? WHERE id = ?`).run(err.message, now, split.id);
      results.push({ invoicingFrom: split.invoicing_from, error: err.message });
    }
  }

  return results;
}

module.exports = {
  INVOICING_FROM_VALUES,
  groupItemsByInvoicingFrom,
  getSplitsForOrder,
  createSplitSalesOrder,
  pushDispatchActionToSplits
};
