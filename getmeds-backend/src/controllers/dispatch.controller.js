const db = require('../db/database');

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

exports.getQueue = (req, res, next) => {
  try {
    const orders = db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name,
             d.status as dispatch_status, d.courier, d.tracking_number, d.created_at as dispatch_created_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      WHERE o.status IN ('ready_for_dispatch', 'picking_packing', 'dispatched')
      ORDER BY o.updated_at ASC
    `).all();
    res.json({ success: true, data: { orders } });
  } catch (err) { next(err); }
};
