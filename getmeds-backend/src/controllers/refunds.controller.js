'use strict';

const db = require('../db/database');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify } = require('../services/notificationService');

/**
 * Refunds for drafts that were paid in advance and then cancelled. Oct 5, 2026.
 *
 * "Cancel and keep record" (orders.controller cancelDraft) leaves the order in the
 * database with refund_status = 'pending'. This is where Finance works those off:
 * the list (read by Finance, Admin and Management so the money owed to customers is
 * visible), the badge summary, and recording the refund (Finance and Admin only).
 *
 * The system only RECORDS a refund. The money moves outside it (bank, e-wallet).
 *
 * Amounts: `refund_received_amount` is what the customer actually paid (defaults to
 * the order total until Finance enters it); `refund_amount` is what goes back, which
 * may be less than received for a partial payment or a cancellation fee. The part
 * kept is simply received minus refunded and is worked out, not stored.
 */

const STATUSES = ['pending', 'done', 'not_due'];
const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const validAmount = (n) => n !== null && Number.isFinite(n) && n >= 0 && n <= 1e9;
const heldExpr = 'COALESCE(o.refund_received_amount, o.total_amount)';
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** GET /api/finance/refunds?status=pending|done|not_due|all */
exports.list = async (req, res, next) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = await db
      .prepare(
        `SELECT o.id, o.getmeds_order_id, o.status, o.total_amount, o.intake_payment_terms,
                o.draft_cancelled_at, o.draft_cancel_reason, o.refund_status,
                ${heldExpr} AS held_amount, o.refund_received_amount, o.refund_amount,
                o.refund_reference, o.refund_at, o.refund_note, o.refund_updated_at,
                c.name AS customer_name, u.name AS medrep_name, cb.name AS cancelled_by_name, rb.name AS refunded_by_name
           FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN users u ON u.id = o.medrep_id
           LEFT JOIN users cb ON cb.id = o.draft_cancelled_by
           LEFT JOIN users rb ON rb.id = o.refund_by
          WHERE o.draft_cancel_kind = 'keep_record' ${status ? 'AND o.refund_status = ?' : ''}
          ORDER BY (o.refund_status = 'pending') DESC, o.draft_cancelled_at DESC
          LIMIT 500`
      )
      .all(...(status ? [status] : []));
    const now = Date.now();
    const refunds = rows.map((r) => ({
      ...r,
      held_amount: Number(r.held_amount) || 0,
      kept_amount: r.refund_status === 'done' ? Math.max(0, (Number(r.refund_received_amount ?? r.total_amount) || 0) - (Number(r.refund_amount) || 0)) : null,
      days_waiting: r.refund_status === 'pending' && r.draft_cancelled_at ? Math.floor((now - Date.parse(r.draft_cancelled_at)) / 86400000) : null
    }));
    res.json({ success: true, data: { refunds, summary: await summary() } });
  } catch (err) { next(err); }
};

async function summary() {
  const r = await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE o.refund_status = 'pending') AS pending_count,
              COALESCE(SUM(${heldExpr}) FILTER (WHERE o.refund_status = 'pending'), 0) AS pending_amount,
              COUNT(*) FILTER (WHERE o.refund_status = 'pending' AND o.draft_cancelled_at < ?) AS overdue_count,
              COUNT(*) FILTER (WHERE o.refund_status = 'done') AS done_count,
              COALESCE(SUM(o.refund_amount) FILTER (WHERE o.refund_status = 'done'), 0) AS done_amount,
              COUNT(*) FILTER (WHERE o.refund_status = 'not_due') AS not_due_count
         FROM orders o WHERE o.draft_cancel_kind = 'keep_record'`
    )
    .get(new Date(Date.now() - 3 * 86400000).toISOString());
  return {
    pending_count: Number(r.pending_count), pending_amount: Number(r.pending_amount), overdue_count: Number(r.overdue_count),
    done_count: Number(r.done_count), done_amount: Number(r.done_amount), not_due_count: Number(r.not_due_count)
  };
}

/** GET /api/finance/refunds/summary — the dashboard badge. One light query. */
exports.summary = async (req, res, next) => {
  try { res.json({ success: true, data: await summary() }); } catch (err) { next(err); }
};

/**
 * POST /api/orders/:id/refund — Finance or Admin records, or corrects, the refund.
 * body: { status, received_amount?, refund_amount?, reference?, refund_date?, note? }
 */
exports.record = async (req, res, next) => {
  try {
    const b = req.body || {};
    const status = String(b.status || '');
    const bad = (code, message, http = 400) => res.status(http).json({ success: false, error: { code, message } });
    if (!STATUSES.includes(status)) return bad('VALIDATION_ERROR', 'Status must be pending, done or not_due.');

    const o = await db
      .prepare(`SELECT o.*, u.email AS medrep_email, c.name AS customer_name FROM orders o
                  LEFT JOIN users u ON u.id = o.medrep_id LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`)
      .get(req.params.id);
    if (!o) return bad('NOT_FOUND', 'Order not found', 404);
    if (o.draft_cancel_kind !== 'keep_record') {
      return bad('NOT_A_KEPT_CANCELLATION', 'Only a cancelled draft kept on record has a refund to record.', 409);
    }

    const received = b.received_amount === undefined ? (o.refund_received_amount ?? o.total_amount) : money(b.received_amount);
    const refund = b.refund_amount === undefined ? o.refund_amount : money(b.refund_amount);
    const reference = b.reference === undefined ? o.refund_reference : String(b.reference || '').trim();
    const note = b.note === undefined ? o.refund_note : String(b.note || '').trim().slice(0, 500);
    const date = b.refund_date === undefined ? o.refund_at : b.refund_date;

    if (!validAmount(Number(received))) return bad('VALIDATION_ERROR', 'Amount received must be zero or more.');
    if (refund !== null && refund !== undefined && !validAmount(Number(refund))) return bad('VALIDATION_ERROR', 'Refund amount must be zero or more.');
    if (refund !== null && refund !== undefined && Number(refund) > Number(received)) {
      return bad('VALIDATION_ERROR', 'The refund cannot be more than the amount received.');
    }
    if (status === 'done') {
      if (!(Number(refund) > 0)) return bad('VALIDATION_ERROR', 'Enter the amount refunded.');
      if (!reference) return bad('VALIDATION_ERROR', 'Enter the refund reference (bank or e-wallet transaction number).');
      if (!validDate(date)) return bad('VALIDATION_ERROR', 'Enter the date the refund was paid (YYYY-MM-DD).');
    }
    if (status === 'not_due' && !note) return bad('VALIDATION_ERROR', 'Say why no refund is due.');

    const actor = await resolveActor(req.user, 'finance');
    const now = new Date().toISOString();
    const before = { status: o.refund_status, received: o.refund_received_amount, refund: o.refund_amount, reference: o.refund_reference };

    await db.prepare(
      `UPDATE orders SET refund_status = ?, refund_received_amount = ?, refund_amount = ?, refund_reference = ?,
                         refund_at = ?, refund_note = ?, refund_by = ?, refund_updated_at = ?, updated_at = ? WHERE id = ?`
    ).run(status, Number(received), status === 'not_due' ? 0 : (refund === undefined ? null : refund), reference || null, status === 'done' ? date : (date || null), note || null, actor.id, now, now, o.id);

    const kept = Math.max(0, Number(received) - (status === 'done' ? Number(refund) : 0));
    await logEvent({
      orderId: o.id, eventType: 'REFUND_RECORDED', actorId: actor.id, actorName: actor.name,
      notes: status === 'done'
        ? `Refund recorded: ₱${Number(refund).toLocaleString('en-PH')} of ₱${Number(received).toLocaleString('en-PH')} received (ref ${reference})${kept ? `; ₱${kept.toLocaleString('en-PH')} kept` : ''}.`
        : status === 'not_due' ? `Closed — no refund due: ${note}` : 'Refund marked pending.',
      metadata: { before, after: { status, received: Number(received), refund: Number(refund) || 0, reference, date }, kept }
    });

    if (status !== before.status && status !== 'pending') {
      await notify({
        orderId: o.id,
        recipientIds: [o.medrep_id, o.raised_by_id].filter(Boolean),
        message: status === 'done'
          ? `Refund done for cancelled draft ${o.getmeds_order_id}: ₱${Number(refund).toLocaleString('en-PH')} (ref ${reference}).`
          : `No refund due for cancelled draft ${o.getmeds_order_id}: ${note}`,
        eventType: 'REFUND_RECORDED',
        orderData: { getmeds_order_id: o.getmeds_order_id, customer_name: o.customer_name, status: o.status, medrep_email: o.medrep_email }
      });
    }
    res.json({ success: true, data: { order: await db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id) } });
  } catch (err) { next(err); }
};
