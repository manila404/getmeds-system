'use strict';

/**
 * Pharmacy — prescription verification, ahead of Finance.
 *
 *   GET  /api/dispatch/pharmacy/queue?state=pending|rejected|verified|all
 *   POST /api/dispatch/pharmacy/orders/:id/verify   { attachment_id? }
 *   POST /api/dispatch/pharmacy/orders/:id/reject   { reason, attachment_id? }
 *
 * Sep 25, 2026.
 *
 * ── Early visibility ───────────────────────────────────────────────────────
 * An order with a prescription appears here as soon as Management has approved
 * it and its Sales Order exists -- the same moment it shows on the Dispatch
 * board's "New draft SOs" -- which is BEFORE Finance has confirmed it. The
 * pharmacist reviews the prescription while Finance checks the payment; the two
 * run in parallel and the order goes out when both are done (see
 * services/prescriptionService.js for the gate).
 *
 * Orders still waiting on Management's approval are not listed: they may yet be
 * rejected or sent back for edits, and a prescription reviewed against an order
 * that then changes is a review wasted.
 *
 * ── What verify / reject do ────────────────────────────────────────────────
 * They record the decision on the prescription file itself (payment_proofs) and
 * on the order's timeline. Neither changes the order's status. Reject needs a
 * reason and tells the MedRep, who replaces the file; the replacement arrives as
 * a new pending prescription and the order returns to the pharmacist's queue.
 *
 * Who: Dispatch (the pharmacy) and Admin decide. Management can look, not decide.
 */

const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
const { importedSql } = require('../services/orderOrigin');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const { rxSummaries, RX_FILE_TYPE, PRE_SHIP_STATUSES } = require('../services/prescriptionService');
const { hasColumn } = require('../services/schemaColumns');

// From "Sales Order created, waiting on Finance" until the parcel is packed.
const PHARMACY_STATUSES = PRE_SHIP_STATUSES;
const FINANCE_CONFIRMED = PRE_SHIP_STATUSES.filter((s) => s !== 'ready_for_finance_verified');

const STATES = ['pending', 'rejected', 'verified'];
const QUEUE_CAP = 500;

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

/** Only the pharmacy (Dispatch) and Admin decide; Management is view-only. */
function mayDecide(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'dispatch' || role === 'admin';
}

exports.getQueue = async (req, res, next) => {
  try {
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const scopeAnd = scopeClause ? ` AND ${scopeClause}` : '';
    const excludeDeleted = (await hasColumn('payment_proofs', 'deleted_at')) ? ' AND p.deleted_at IS NULL' : '';

    const orders = await db
      .prepare(
        `SELECT o.id, o.getmeds_order_id, o.status, o.division, o.total_amount, o.created_at, o.updated_at,
                o.zoho_so_number, o.delivery_notes,
                c.name AS customer_name, u.name AS medrep_name
           FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN users u ON u.id = o.medrep_id
          WHERE o.status = ANY(?)
            AND NOT (${importedSql('o')})
            AND EXISTS (SELECT 1 FROM payment_proofs p
                         WHERE p.order_id = o.id AND p.file_type = '${RX_FILE_TYPE}'${excludeDeleted})${scopeAnd}
          ORDER BY o.created_at DESC
          LIMIT ${QUEUE_CAP}`
      )
      .all([PHARMACY_STATUSES, ...scopeParams]);

    const summaries = await rxSummaries(orders.map((o) => o.id));
    const rows = orders.map((o) => {
      const s = summaries.get(o.id);
      return {
        ...o,
        finance_cleared: FINANCE_CONFIRMED.includes(o.status),
        rx_state: s.state,
        prescriptions: s.prescriptions,
      };
    });

    const counts = { pending: 0, rejected: 0, verified: 0, all: rows.length };
    for (const r of rows) if (STATES.includes(r.rx_state)) counts[r.rx_state] += 1;

    const wanted = String(req.query.state || 'pending').toLowerCase();
    const shown = wanted === 'all' ? rows : rows.filter((r) => r.rx_state === wanted);

    res.json({ success: true, data: { orders: shown, counts, can_decide: mayDecide(req.user) } });
  } catch (err) {
    next(err);
  }
};

async function loadOrder(id) {
  return await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id, o.raised_by_id, c.name AS customer_name
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
    )
    .get(id);
}

/** The prescriptions this decision applies to: the one named, or every pending one. */
async function pendingRows(orderId, attachmentId) {
  const excludeDeleted = (await hasColumn('payment_proofs', 'deleted_at')) ? ' AND deleted_at IS NULL' : '';
  const byId = attachmentId != null && attachmentId !== '';
  return await db
    .prepare(
      `SELECT id, storage_path, file_name FROM payment_proofs
        WHERE order_id = ? AND file_type = '${RX_FILE_TYPE}' AND status = 'pending'${excludeDeleted}${byId ? ' AND id = ?' : ''}
        ORDER BY id`
    )
    .all(...(byId ? [orderId, parseInt(attachmentId, 10)] : [orderId]));
}

async function decide(req, res, next, verdict) {
  try {
    if (!mayDecide(req.user)) {
      return fail(res, 403, 'FORBIDDEN', 'Only the pharmacy (Dispatch) can verify or reject a prescription.');
    }

    const reason = String(req.body?.reason || '').trim();
    if (verdict === 'rejected') {
      if (!reason) return fail(res, 400, 'VALIDATION_ERROR', 'A reason is required: it is what the MedRep acts on.');
      if (reason.length > 500) return fail(res, 400, 'VALIDATION_ERROR', 'The reason is too long (500 characters at most).');
    }

    const order = await loadOrder(req.params.id);
    if (!order) return fail(res, 404, 'NOT_FOUND', 'Order not found');
    if (!PHARMACY_STATUSES.includes(order.status)) {
      return fail(
        res,
        409,
        'NOT_IN_QUEUE',
        `Prescriptions are reviewed once the order is approved and until it is packed. This one is at "${order.status}".`
      );
    }

    const rows = await pendingRows(order.id, req.body?.attachment_id);
    if (!rows.length) return fail(res, 404, 'NOTHING_TO_REVIEW', 'No prescription is waiting for review on this order.');

    const actor = await resolveActor(req.user, 'dispatch');
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);

    await db.transaction(async () => {
      // Guarded on status = 'pending' so two pharmacists acting at once produce
      // one decision, not two on the same file.
      const upd = await db
        .prepare(
          `UPDATE payment_proofs
              SET status = ?, verified_by = ?, verified_at = ?, rejection_reason = ?
            WHERE id = ANY(?) AND status = 'pending'`
        )
        .run(verdict, actor.id, now, verdict === 'rejected' ? reason : null, [ids]);
      if (!upd.changes) {
        const conflict = new Error('Someone else already reviewed this prescription.');
        conflict.statusCode = 409;
        conflict.code = 'ALREADY_REVIEWED';
        throw conflict;
      }

      await logEvent({
        orderId: order.id,
        eventType: verdict === 'verified' ? 'RX_VERIFIED' : 'RX_REJECTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes:
          verdict === 'verified'
            ? `Prescription verified by Pharmacy (${rows.map((r) => r.file_name).filter(Boolean).join(', ') || `${rows.length} file(s)`})`
            : `Prescription rejected by Pharmacy: ${reason}`,
        metadata: { attachmentIds: ids, ...(verdict === 'rejected' ? { reason } : {}) },
      });

      if (verdict === 'rejected') {
        await notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_id, order.raised_by_id].filter(Boolean))),
          message: `The prescription for order ${order.getmeds_order_id} was rejected by Pharmacy: ${reason}. Please upload a replacement.`,
          eventType: 'RX_REJECTED',
          orderData: order,
        });
      }
    })();

    const s = (await rxSummaries([order.id])).get(order.id);
    res.json({ success: true, data: { id: order.id, rx_state: s.state, prescriptions: s.prescriptions } });
  } catch (err) {
    if (err && err.statusCode === 409) return fail(res, 409, err.code || 'CONFLICT', err.message);
    next(err);
  }
}

exports.verify = (req, res, next) => decide(req, res, next, 'verified');
exports.reject = (req, res, next) => decide(req, res, next, 'rejected');
exports.PHARMACY_STATUSES = PHARMACY_STATUSES;
