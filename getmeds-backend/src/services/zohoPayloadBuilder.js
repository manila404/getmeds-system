const db = require('../db/database');

/**
 * Aug 31, 2026: built to fix the "edited an order's items after a failed
 * Zoho sync, but the retry still sent the old item" bug.
 *
 * Before this file existed, `zoho_sync_queue.payload` was a one-time JSON
 * snapshot taken at the moment of the ORIGINAL failed sync attempt (see
 * orders.controller.js's `create`/`submit`, which each build their own
 * zohoPayload and hand it to zohoRetryService.enqueue()). Every later retry
 * — automatic or the manual "Retry Zoho Sync" button — just did
 * `JSON.parse(row.payload)` and resent that exact frozen payload. So the
 * PATCH /api/orders/:id/items "Edit Items" feature (added the same day, to
 * fix a bad line item like an inactive Zoho product) updated the order in
 * the database correctly, but had ZERO effect on what a retry actually sent
 * to Zoho — it kept resending the original, still-broken item forever,
 * until it gave up permanently after ZOHO_RETRY_MAX_ATTEMPTS.
 *
 * This function rebuilds the payload fresh from the order's CURRENT
 * database state (its customer + live order_items) every time it's called,
 * so zohoRetryService can call it right before each retry attempt instead
 * of trusting anything captured earlier. The shape matches exactly what
 * orders.controller.js's `create`/`submit` send on the first attempt.
 *
 * Returns null if the order no longer exists.
 */
async function buildZohoSalesOrderPayload(orderId) {
  const order = await db.prepare(`
    SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.zoho_contact_id as customer_zoho_contact_id,
           u.salesperson as medrep_salesperson, u.division as medrep_division, u.sub_division as medrep_sub_division
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON o.medrep_id = u.id
    WHERE o.id = ?
  `).get(orderId);

  if (!order) return null;

  const items = await db.prepare(`
    SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `).all(orderId);

  return {
    getmeds_order_id: order.getmeds_order_id,
    customer_name: order.customer_name,
    customer_type: order.customer_type,
    customer_master_type: order.customer_master_type,
    zoho_customer_id: order.customer_zoho_contact_id || null,
    total_amount: order.total_amount,
    delivery_address: order.delivery_address,
    items,
    doctor_name: order.intake_doctor,
    order_source: order.intake_source,
    invoicing_from: order.invoicing_from,
    // Sep 2, 2026: the Salesperson of the MedRep who owns the order. Read
    // fresh here like everything else in this function — if the rep's
    // division or display name was corrected after the failed sync, the
    // retry sends the corrected string rather than the one that failed.
    // That is the entire point of rebuilding the payload instead of
    // replaying the stored snapshot.
    //
    // Sep 11, 2026: the ORDER's own Salesperson wins when it has one, same as
    // submit() does. A rep can cover several Salespersons now and picks one
    // per order; a retry falling back to the account would resend the rep's
    // primary instead of the one this order was actually raised under.
    salesperson_name: order.salesperson || order.medrep_salesperson || null,
    // Same row, same reason as salesperson above — a division corrected
    // after a failed sync is picked up by the retry.
    division: order.medrep_division || null,
    sub_division: order.medrep_sub_division || null,
    // Sep 8, 2026: Delivery Method and Terms — matches the shape create()/
    // submit() now send on the first attempt (see orders.controller.js),
    // so a retry sends the same fields rather than a stale, narrower shape.
    delivery_method: order.intake_delivery_method || null,
    terms: order.intake_terms || null,
    // Sep 8, 2026 (2): Payment Terms — same reasoning, same raw-string shape.
    payment_terms: order.intake_payment_terms || null,
    // Sep 9, 2026: see orders.controller.js — a retry must send the same
    // Expected Shipment Date the first attempt did, which is the entire
    // reason this file rebuilds from the database instead of replaying a
    // frozen snapshot.
    expected_shipment_date: order.intake_expected_shipment_date || null,
    // Sep 8, 2026 (3): GM Lead ID — set once at create() time (see
    // orders.controller.js's gmLeadId note) and simply read back here,
    // like everything else in this rebuild — `SELECT o.*` above already
    // picks it up now that it's a real column.
    gm_lead_id: order.gm_lead_id || null
  };
}

module.exports = { buildZohoSalesOrderPayload };
