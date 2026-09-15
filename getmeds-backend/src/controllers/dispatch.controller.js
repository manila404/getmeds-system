const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
const { importedSql } = require('../services/orderOrigin');
const { isWorkflowV2Enabled } = require('../services/workflowFlags');
const workflow = require('../services/workflowV2Service');
const { workflowAction } = require('./workflowAction');
const { logEvent, resolveActor } = require('../services/auditService');

// ─── Confirmed for delivery (Sep 15, 2026) ─────────────────────────────────
// Dispatch prints the delivery slip, checks the address, and confirms the
// order is going out to it. Confirmed with the business: it RECORDS that and
// nothing else — no status change, nothing sent to Zoho; packing and shipping
// carry on exactly as before.
//
// Kept as an order event rather than a column, so it needs no migration and
// the timeline shows it for free. The address confirmed goes in the event's
// metadata: an address edited afterwards shows as "changed since confirmed"
// instead of a stale tick.

// Finance has confirmed these and the parcel has not left: the orders
// Dispatch can confirm for delivery, and the "Confirmed by Finance" list.
const FINANCE_CONFIRMED = ['ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'];

// The latest confirmation for each order row.
const CONFIRMATION_JOIN = `
      LEFT JOIN LATERAL (
        SELECT e.actor_name AS delivery_confirmed_by, e.created_at AS delivery_confirmed_at,
               e.metadata AS delivery_confirmed_meta
          FROM order_events e
         WHERE e.order_id = o.id AND e.event_type = 'DELIVERY_CONFIRMED'
         ORDER BY e.id DESC LIMIT 1
      ) dc ON TRUE`;

/** The confirmation as the page reads it, including whether the address moved since. */
function withConfirmation(row) {
  const { delivery_confirmed_meta: meta, ...rest } = row;
  let confirmedAddress = null;
  try {
    confirmedAddress = JSON.parse(meta || 'null')?.delivery_address ?? null;
  } catch {
    confirmedAddress = null;
  }
  return {
    ...rest,
    delivery_confirmed_address: confirmedAddress,
    delivery_address_changed:
      Boolean(row.delivery_confirmed_at) && confirmedAddress !== null &&
      String(confirmedAddress).trim() !== String(row.delivery_address || '').trim()
  };
}

// ─── Dispatch queue ────────────────────────────────────────────────────────
// Until Sep 12, 2026 this page was read-only: picking, packing, dispatch and
// tracking status came FROM Zoho Inventory (Package created → picking_packing,
// Shipment created → dispatched → tracking_shared — see webhook.controller.js)
// and nobody pressed anything here.
//
// With GETMEDS_WORKFLOW_V2 on, Dispatch does that work here instead — create
// and send the invoice, mark packed, ship, mark delivered — and each button
// makes the matching change in Zoho (services/workflowV2Service.js). The
// webhooks still run, and recognise those changes as already recorded.
// With the switch off, this is exactly the read-only queue it was.

// Where each v2 step starts. The page groups rows by these.
const V2_STEPS = {
  needs_invoice: ['ready_for_draft_invoice', 'ready_for_invoice_sent'],
  ready_to_pack: ['ready_for_dispatch'],
  ready_to_ship: ['picking_packing'],
  // 'completed' too: shipped AND already paid closes the order the moment it
  // ships, but the parcel is still on the road. Only orders shipped from this
  // app qualify (the query requires the Zoho shipment id Ship records) — every
  // order completed before the switch has no delivery to mark.
  awaiting_delivery: ['dispatched', 'tracking_shared', 'completed']
};
const V2_STATUSES = Object.values(V2_STEPS).flat().filter((s) => s !== 'completed');

exports.getQueue = async (req, res, next) => {
  try {
    // Sep 11, 2026 (Phase C): narrowed to the viewer's divisions.
    //
    // This queue is open to `management` as well as its own role, so without
    // this a division-scoped manager would see every order in it — the same
    // leak the orders list has, on a page nobody thinks of as an orders list.
    // loadScope returns full scope for Dispatch users themselves, so their queue is
    // unchanged.
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const scopeAnd = scopeClause ? ` AND ${scopeClause}` : '';
    const v2 = isWorkflowV2Enabled();

    const select = `
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name,
             d.status as dispatch_status, d.courier, d.tracking_number, d.created_at as dispatch_created_at,
             d.zoho_package_number, d.zoho_shipment_number, d.delivered_at,
             dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON o.id = d.order_id${CONFIRMATION_JOIN}`;

    let orders;
    if (v2) {
      // Dispatch's work now starts at "needs invoice" and ends when the parcel
      // arrives, so a shipped order stays here until someone marks it
      // delivered. Imported Zoho orders are left out: they are history, and
      // pressing a button on one would write to a Sales Order someone finished
      // in Zoho long ago.
      orders = await db.prepare(`${select}
        WHERE (o.status = ANY(?) OR (o.status = 'completed' AND d.zoho_shipment_id IS NOT NULL))
          AND d.delivered_at IS NULL
          AND NOT (${importedSql('o')})${scopeAnd}
        ORDER BY o.updated_at ASC
      `).all([V2_STATUSES, ...scopeParams]);
    } else {
      orders = await db.prepare(`${select}
        -- Sep 1, 2026 (5): 'ready_for_dispatch' now MEANS "the invoice has been
        -- issued, this is yours to pack" — it used to mean "the Sales Order is
        -- confirmed". That rename is exactly what this queue wanted: the
        -- warehouse sees an order at the point Finance is done with it, and the
        -- two finance stages ahead of it (ready_for_draft_invoice,
        -- ready_for_invoice_sent) correctly stay out of this list.
        WHERE o.status IN ('ready_for_dispatch', 'picking_packing', 'dispatched')${scopeAnd}
        ORDER BY o.updated_at ASC
      `).all(...scopeParams);
    }
    res.json({ success: true, data: { orders: orders.map(withConfirmation), workflow_v2: v2, steps: v2 ? V2_STEPS : null } });
  } catch (err) { next(err); }
};

/**
 * GET /api/dispatch/recent — what is coming Dispatch's way.
 *
 * Sep 15, 2026. The queue above starts once an order is Dispatch's to work,
 * so the orders on their way were invisible here. Two lists, newest first:
 *   new_draft_sos      in Zoho as a draft Sales Order, waiting on Finance —
 *                      a heads-up only
 *   finance_confirmed  Finance has confirmed them and the parcel has not left
 *                      yet — these can be printed and confirmed for delivery
 * Imported Zoho history is left out, as in the queue.
 */
exports.getRecent = async (req, res, next) => {
  try {
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const scopeAnd = scopeClause ? ` AND ${scopeClause}` : '';
    const columns = `
        o.id, o.getmeds_order_id, o.status, o.total_amount, o.delivery_address, o.delivery_notes,
        o.intake_receiver, o.intake_contact_no, o.intake_delivery_method,
        o.zoho_so_number, o.zoho_so_status, o.created_at, o.updated_at,
        c.name AS customer_name, c.contact_number, u.name AS medrep_name,
        dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta`;
    const from = `
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u ON u.id = o.medrep_id${CONFIRMATION_JOIN}`;

    // One array argument each: see db/pg.js's flatten().
    const drafts = await db.prepare(`
      SELECT ${columns} ${from}
       WHERE o.status = 'ready_for_finance_verified' AND o.zoho_so_id IS NOT NULL
         AND NOT (${importedSql('o')})${scopeAnd}
       ORDER BY o.created_at DESC
       LIMIT 20
    `).all([...scopeParams]);

    const confirmed = await db.prepare(`
      SELECT ${columns}, fv.finance_confirmed_at, fv.finance_confirmed_by ${from}
      LEFT JOIN LATERAL (
        SELECT fe.created_at AS finance_confirmed_at, fe.actor_name AS finance_confirmed_by
          FROM order_events fe
         WHERE fe.order_id = o.id AND fe.event_type = 'FINANCE_VERIFIED'
         ORDER BY fe.id DESC LIMIT 1
      ) fv ON TRUE
       WHERE o.status = ANY(?)
         AND NOT (${importedSql('o')})${scopeAnd}
       ORDER BY COALESCE(fv.finance_confirmed_at, o.updated_at) DESC
       LIMIT 20
    `).all([FINANCE_CONFIRMED, ...scopeParams]);

    res.json({
      success: true,
      data: {
        new_draft_sos: drafts.map(withConfirmation),
        finance_confirmed: confirmed.map(withConfirmation)
      }
    });
  } catch (err) { next(err); }
};

/**
 * POST /api/dispatch/orders/:id/confirm-delivery — "this is going out, to
 * this address". Records who and when on the order's timeline; changes
 * nothing else. Confirming again (after the address was corrected, say) adds
 * a new entry and the latest one counts.
 */
exports.confirmDelivery = async (req, res, next) => {
  try {
    const order = await db.prepare(`
      SELECT o.*, c.name AS customer_name
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ?
    `).get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (!FINANCE_CONFIRMED.includes(order.status)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_CONFIRMABLE',
          message:
            'Only an order Finance has confirmed, and that has not shipped yet, can be confirmed for delivery. ' +
            `This one is at "${order.status}".`
        }
      });
    }
    const address = String(order.delivery_address || '').trim();
    if (!address) {
      return res.status(409).json({
        success: false,
        error: { code: 'NO_ADDRESS', message: 'This order has no delivery address to confirm. Ask the MedRep to add one.' }
      });
    }

    const actor = await resolveActor(req.user, 'dispatch');
    const receiver = [order.intake_receiver, order.intake_contact_no].filter(Boolean).join(', ');
    await logEvent({
      orderId: order.id,
      eventType: 'DELIVERY_CONFIRMED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: `Confirmed for delivery to: ${address}${receiver ? ` (receiver: ${receiver})` : ''}.`,
      metadata: {
        delivery_address: address,
        receiver: order.intake_receiver || null,
        contact_no: order.intake_contact_no || null
      }
    });

    const latest = await db.prepare(`
      SELECT actor_name, created_at FROM order_events
       WHERE order_id = ? AND event_type = 'DELIVERY_CONFIRMED'
       ORDER BY id DESC LIMIT 1
    `).get(order.id);
    res.json({
      success: true,
      data: {
        id: order.id,
        delivery_confirmed_by: latest?.actor_name || actor.name,
        delivery_confirmed_at: latest?.created_at || null,
        message: `${order.getmeds_order_id} confirmed for delivery to ${address}.`
      }
    });
  } catch (err) { next(err); }
};

/** GET /api/dispatch/orders/:id/slip — everything the printed delivery slip shows. */
exports.getSlip = async (req, res, next) => {
  try {
    const order = await db.prepare(`
      SELECT o.id, o.getmeds_order_id, o.status, o.zoho_so_number, o.delivery_address, o.delivery_notes,
             o.intake_receiver, o.intake_contact_no, o.intake_delivery_method, o.sales_order_date,
             o.created_at, o.total_amount,
             c.name AS customer_name, c.contact_number, u.name AS medrep_name,
             dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN users u ON u.id = o.medrep_id${CONFIRMATION_JOIN}
       WHERE o.id = ?
    `).get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    const items = await db.prepare(`
      SELECT p.name, p.sku, oi.quantity
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id
    `).all(order.id);
    res.json({ success: true, data: { order: withConfirmation(order), items } });
  } catch (err) { next(err); }
};

exports.createInvoice = workflowAction((req) =>
  workflow.createInvoice({ orderId: req.params.id, user: req.user }));

exports.markPacked = workflowAction((req) =>
  workflow.markPacked({ orderId: req.params.id, user: req.user }));

exports.ship = workflowAction((req) =>
  workflow.ship({
    orderId: req.params.id,
    user: req.user,
    courier: req.body && req.body.courier,
    trackingNumber: req.body && req.body.trackingNumber
  }));

exports.markDelivered = workflowAction((req) =>
  workflow.markDelivered({ orderId: req.params.id, user: req.user }));
