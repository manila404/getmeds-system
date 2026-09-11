const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');

// ─── Dispatch visibility (read-only) ───────────────────────────────────────
// Picking, packing, dispatch and tracking status now come FROM Zoho
// Inventory (Package created → picking_packing, Shipment created →
// dispatched → tracking_shared → completed — see webhook.controller.js),
// not from a local button the Dispatch team clicks in this app. This
// mirrors the Finance flow change: the app is a front-door + notification
// hub, Zoho is the system of record for what Dispatch actually does.
//
// The old updateStatus / enterTracking actions (which pushed status TO
// Zoho) have been retired for the same reason verify-payment was retired
// from finance.controller.js.

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
    const orders = await db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name,
             d.status as dispatch_status, d.courier, d.tracking_number, d.created_at as dispatch_created_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      -- Sep 1, 2026 (5): 'ready_for_dispatch' now MEANS "the invoice has been
      -- issued, this is yours to pack" — it used to mean "the Sales Order is
      -- confirmed". That rename is exactly what this queue wanted: the
      -- warehouse sees an order at the point Finance is done with it, and the
      -- two finance stages ahead of it (ready_for_draft_invoice,
      -- ready_for_invoice_sent) correctly stay out of this list.
      WHERE o.status IN ('ready_for_dispatch', 'picking_packing', 'dispatched')${scopeAnd}
      ORDER BY o.updated_at ASC
    `).all(...scopeParams);
    res.json({ success: true, data: { orders } });
  } catch (err) { next(err); }
};
