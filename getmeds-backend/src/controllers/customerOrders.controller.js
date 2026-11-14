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
const attachmentLink = require('../services/attachmentLinkService');

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

    // Nov 14, 2026 (Aaron): what the client bought, so Pharmacy can hold it against the doctor's
    // prescription and catch a quantity beyond it. The lines of every order, and the same lines
    // added up per medicine.
    const lines = ids.length ? await db.prepare(
      `SELECT oi.order_id, oi.product_id, p.name, p.unit, oi.quantity, oi.unit_price, oi.line_total
         FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ANY(?)
        ORDER BY oi.id`
    ).all([ids]) : [];
    const linesByOrder = new Map();
    for (const l of lines) {
      if (!linesByOrder.has(l.order_id)) linesByOrder.set(l.order_id, []);
      linesByOrder.get(l.order_id).push({ product_id: l.product_id, name: l.name, unit: l.unit, quantity: Number(l.quantity), unit_price: Number(l.unit_price), line_total: Number(l.line_total) });
    }

    // The prescription files themselves (view links, signed like every other attachment link),
    // so the pharmacist can read the prescribed quantity next to what was bought.
    const origin = `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.get('host')}`;
    const files = ids.length ? await db.prepare(
      `SELECT id, order_id, file_name, content_type, status, uploaded_at
         FROM payment_proofs
        WHERE order_id = ANY(?) AND file_type = 'prescription' AND deleted_at IS NULL
        ORDER BY id`
    ).all([ids]) : [];
    const rxByOrder = new Map();
    for (const f of files) {
      const token = attachmentLink.sign(f.id, f.order_id);
      if (!rxByOrder.has(f.order_id)) rxByOrder.set(f.order_id, []);
      rxByOrder.get(f.order_id).push({
        id: f.id, file_name: f.file_name, status: f.status, uploaded_at: f.uploaded_at,
        is_image: String(f.content_type || '').startsWith('image/'),
        view_url: `${origin}/api/attachment-view?token=${token}`,
        thumb_url: `${origin}/api/attachment-view?token=${token}&w=300&h=300`
      });
    }

    const out = orders.map((o) => ({
      ...o, rx_files: Number(o.rx_files) || 0, rx_state: stateOf(o.id),
      items: linesByOrder.get(o.id) || [], prescriptions: rxByOrder.get(o.id) || []
    }));

    // Per medicine: total bought, on how many orders, first and last time, and how much of it was
    // on orders that carried a prescription. Cancelled orders do not count as bought.
    const meds = new Map();
    for (const o of out) {
      if (o.status === 'cancelled') continue;
      for (const l of o.items) {
        // free lines (a "buy one take one" promo at ₱0) are dispensed too, so they count
        const m = meds.get(l.product_id) || { product_id: l.product_id, name: l.name, unit: l.unit, total_qty: 0, orderIds: new Set(), rx_qty: 0, first_at: o.created_at, last_at: o.created_at, lines: [] };
        m.total_qty += l.quantity;
        m.orderIds.add(o.id);
        if (['verified', 'pending', 'rejected'].includes(o.rx_state)) m.rx_qty += l.quantity;
        if (o.created_at < m.first_at) m.first_at = o.created_at;
        if (o.created_at > m.last_at) m.last_at = o.created_at;
        m.lines.push({ order_id: o.id, getmeds_order_id: o.getmeds_order_id, created_at: o.created_at, quantity: l.quantity, rx_state: o.rx_state, prescriptions: o.prescriptions, doctor: o.doctor });
        meds.set(l.product_id, m);
      }
    }

    res.json({
      success: true,
      data: {
        customer,
        orders: out,
        medicines: [...meds.values()]
          .map(({ orderIds, ...m }) => ({ ...m, orders: orderIds.size }))
          .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))),
        limited: orders.length === LIMIT
      }
    });
  } catch (err) { next(err); }
};
