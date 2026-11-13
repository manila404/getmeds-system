'use strict';

/**
 * GET /api/customers/:id/orders — one client's order history, newest first, with each order's
 * prescription state. Nov 14, 2026 (Aaron).
 *
 * For Pharmacy (Dispatch role) to backtrack a client's orders, especially the ones that needed a
 * prescription, from the Clients Directory. Dispatch, Management and Admin only: every one of them
 * can already open any order. MedReps and Team Leads are not given it, since it would show other
 * reps' orders for the same client.
 *
 * Read only. The prescription state is the same one the Pharmacy page shows
 * (prescriptionService.rxSummaries): none, pending, rejected, verified, not required, or requested.
 */

const db = require('../db/database');
const { rxSummaries } = require('../services/prescriptionService');

const LIMIT = 200;

exports.getCustomerOrders = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid client id' } });
    const customer = await db.prepare('SELECT id, name, category, type, contact_number, address FROM customers WHERE id = ?').get(id);
    if (!customer) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Client not found' } });

    const orders = await db.prepare(
      `SELECT o.id, o.getmeds_order_id, o.created_at, o.status, o.total_amount, o.zoho_so_number, o.division,
              o.intake_doctor AS doctor, u.name AS medrep,
              (SELECT COUNT(*) FROM payment_proofs p WHERE p.order_id = o.id AND p.file_type = 'prescription' AND p.deleted_at IS NULL) AS rx_files
         FROM orders o LEFT JOIN users u ON u.id = o.medrep_id
        WHERE o.customer_id = ? AND o.status <> 'deleted'
        ORDER BY o.created_at DESC
        LIMIT ${LIMIT}`
    ).all(id);

    const ids = orders.map((o) => o.id);
    const rx = ids.length ? await rxSummaries(ids) : new Map();
    // none | pending | rejected | verified | not_required, plus 'requested' (Pharmacy asked for one).
    const stateOf = (oid) => {
      const s = rx.get(oid);
      if (!s) return 'none';
      return s.state === 'none' && s.requested ? 'requested' : s.state;
    };

    res.json({
      success: true,
      data: {
        customer,
        orders: orders.map((o) => ({ ...o, rx_files: Number(o.rx_files) || 0, rx_state: stateOf(o.id) })),
        limited: orders.length === LIMIT
      }
    });
  } catch (err) { next(err); }
};
