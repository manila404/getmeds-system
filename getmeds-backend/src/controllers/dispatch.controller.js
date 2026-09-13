const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
const { importedSql } = require('../services/orderOrigin');
const { isWorkflowV2Enabled } = require('../services/workflowFlags');
const workflow = require('../services/workflowV2Service');
const { workflowAction } = require('./workflowAction');

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
             d.zoho_package_number, d.zoho_shipment_number, d.delivered_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON o.id = d.order_id`;

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
    res.json({ success: true, data: { orders, workflow_v2: v2, steps: v2 ? V2_STEPS : null } });
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
