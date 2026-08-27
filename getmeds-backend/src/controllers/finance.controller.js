const db = require('../db/database');

// ─── Finance visibility (read-only) ────────────────────────────────────────
//
// Finance verification happens IN ZOHO, not in this app. The real workflow
// is: MedRep submits an order here -> it syncs to Zoho as a Sales Order ->
// Finance confirms the Sales Order in Zoho -> Finance converts it to an
// Invoice in Zoho -> Finance records the Customer Payment in Zoho. Every one
// of those Zoho-side actions calls back to POST /api/webhooks/zoho (see
// webhook.controller.js), which is what actually advances the order's
// status here. This controller no longer writes order/payment status — it
// only reads what the webhooks already wrote, so Finance staff can see
// where each order stands without leaving this app. (The previous
// verify-payment / sync-payment actions that pushed status from this app
// TO Zoho have been retired — Zoho is the system of record for this part
// of the flow now.)

// Orders currently waiting on a Zoho-side finance action: Sales Order
// confirmed but not yet invoiced ('waiting_for_payment'), or invoiced in
// Zoho but payment not yet recorded ('invoice_drafted').
exports.getQueue = (req, res, next) => {
  try {
    const orders = db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name, u.email as medrep_email,
             p.status as payment_status, p.payment_reference, p.amount as payment_amount
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      WHERE o.status IN ('waiting_for_payment', 'invoice_drafted')
      ORDER BY o.submitted_at ASC
    `).all();
    res.json({ success: true, data: { orders } });
  } catch (err) { next(err); }
};

// Payment details for a specific order — populated by the Zoho webhook once
// Finance records the Customer Payment in Zoho, not by any action in here.
exports.getPayment = (req, res, next) => {
  try {
    const payment = db.prepare(`
      SELECT p.*, u.name as verified_by_name, o.getmeds_order_id, o.total_amount, o.customer_type,
             o.zoho_so_number, o.zoho_invoice_number
      FROM payments p
      LEFT JOIN users u ON p.verified_by = u.id
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.order_id = ?
    `).get(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No payment record found for this order' } });
    res.json({ success: true, data: { payment } });
  } catch (err) { next(err); }
};
