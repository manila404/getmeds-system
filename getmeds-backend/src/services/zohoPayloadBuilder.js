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
function buildZohoSalesOrderPayload(orderId) {
  const order = db.prepare(`
    SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.zoho_contact_id as customer_zoho_contact_id
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    WHERE o.id = ?
  `).get(orderId);

  if (!order) return null;

  const items = db.prepare(`
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
    invoicing_from: order.invoicing_from
  };
}

module.exports = { buildZohoSalesOrderPayload };
