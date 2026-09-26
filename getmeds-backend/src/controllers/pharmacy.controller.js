'use strict';

/**
 * Pharmacy — prescription verification, ahead of Finance.
 *
 *   GET  /api/dispatch/pharmacy/queue?state=pending|rejected|verified|all|all_orders&channel=HOS|Telesales|B%26B|STC|URO|B2C
 *        all_orders: every native order of those six channels since Sep 12, 2026, prescription or not
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
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { rxSummaries, prescriptionRows, summarize, isPharmacyReviewable, RX_FILE_TYPE, PRE_SHIP_STATUSES } = require('../services/prescriptionService');
const { hasColumn } = require('../services/schemaColumns');

// From "Sales Order created, waiting on Finance" until the parcel is packed.
const PHARMACY_STATUSES = PRE_SHIP_STATUSES;
const FINANCE_CONFIRMED = PRE_SHIP_STATUSES.filter((s) => s !== 'ready_for_finance_verified');

const STATES = ['pending', 'rejected', 'verified'];

// The stage an on-hold order was at just before its latest hold. An order held
// FROM one of the pharmacy stages stays in the pharmacist's queue: a Finance hold
// must not stop Pharmacy working its own track (see services/prescriptionService.js).
const HELD_FROM_SQL = `(SELECT e.old_status FROM order_events e
                          WHERE e.order_id = o.id AND e.new_status = 'on_hold' AND e.old_status <> 'on_hold'
                          ORDER BY e.id DESC LIMIT 1)`;

// Sep 26, 2026: the six sales channels a pharmacist audits, as the divisions that
// carry them on an order. Telesales is TeleSales + TeleSales Anesthesia; B2C is
// B2C + MD Telesales (the sheet renamed MD Telesales to B2C, see
// services/managerAccessSyncService.js, which holds the same mapping).
const PHARMACY_CHANNELS = {
  HOS: ['HOS'],
  Telesales: ['TeleSales', 'TeleSales Anesthesia'],
  'B&B': ['B&B'],
  STC: ['STC'],
  URO: ['URO'],
  B2C: ['B2C', 'MD Telesales'],
};
const ALL_ORDERS_DIVISIONS = Object.values(PHARMACY_CHANNELS).flat();

// "All orders" starts on Sep 12, 2026 (00:00 in Manila is 16:00 the day before, UTC).
const ALL_ORDERS_SINCE = '2026-09-11T16:00:00.000Z';
// Never a live order yet, or already discarded: nothing for a pharmacist to audit.
const ALL_ORDERS_EXCLUDED_STATUSES = ['draft', 'deleted'];
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

    // Channel pill: one of the six, or none. It narrows every tab.
    const channel = Object.keys(PHARMACY_CHANNELS).find((k) => k.toLowerCase() === String(req.query.channel || '').toLowerCase()) || null;
    const channelAnd = channel ? ' AND o.division = ANY(?)' : '';
    const channelParams = channel ? [PHARMACY_CHANNELS[channel]] : [];

    const columns = `o.id, o.getmeds_order_id, o.status, o.division, o.total_amount, o.created_at, o.updated_at,
                o.zoho_so_number, o.delivery_notes,
                c.name AS customer_name, u.name AS medrep_name,
                CASE WHEN o.status = 'on_hold' THEN ${HELD_FROM_SQL} END AS held_from`;
    const joins = `FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN users u ON u.id = o.medrep_id`;

    // Orders that carry a prescription, from Management's approval until packed.
    const orders = await db
      .prepare(
        `SELECT ${columns}
           ${joins}
          WHERE (o.status = ANY(?) OR (o.status = 'on_hold' AND ${HELD_FROM_SQL} = ANY(?)))
            AND NOT (${importedSql('o')})
            AND EXISTS (SELECT 1 FROM payment_proofs p
                         WHERE p.order_id = o.id AND p.file_type = '${RX_FILE_TYPE}'${excludeDeleted})${channelAnd}${scopeAnd}
          ORDER BY o.created_at DESC
          LIMIT ${QUEUE_CAP}`
      )
      .all([PHARMACY_STATUSES, PHARMACY_STATUSES, ...channelParams, ...scopeParams]);

    // "All orders": every order of the six channels, whether or not a prescription
    // is attached, so the pharmacist can look at the items and notes and decide if
    // one is needed. Native GM- orders only, from Sep 12, 2026.
    const allOrdersSql = `${joins}
          WHERE o.getmeds_order_id LIKE 'GM-%'
            AND NOT (${importedSql('o')})
            AND o.created_at >= ?
            AND NOT (o.status = ANY(?))
            AND o.division = ANY(?)${channelAnd}${scopeAnd}`;
    const allOrdersParams = [ALL_ORDERS_SINCE, ALL_ORDERS_EXCLUDED_STATUSES, ALL_ORDERS_DIVISIONS, ...channelParams, ...scopeParams];
    const allOrdersCount = Number(
      (await db.prepare(`SELECT COUNT(*) AS n ${allOrdersSql}`).get(allOrdersParams)).n
    );

    const wanted = String(req.query.state || 'pending').toLowerCase();
    const wantAllOrders = wanted === 'all_orders';
    const listed = wantAllOrders
      ? await db.prepare(`SELECT ${columns} ${allOrdersSql} ORDER BY o.created_at DESC LIMIT ${QUEUE_CAP}`).all(allOrdersParams)
      : orders;

    const listedIds = [...new Set([...orders, ...listed].map((o) => o.id))];
    const summaries = await rxSummaries(listedIds);

    // The MedRep's latest answer to a rejection, so the pharmacist sees what they said.
    const resubmits = new Map();
    if (listedIds.length) {
      const answers = await db
        .prepare(
          `SELECT DISTINCT ON (order_id) order_id, actor_name, created_at, metadata
             FROM order_events
            WHERE event_type = 'RX_RESUBMITTED' AND order_id = ANY(?)
            ORDER BY order_id, id DESC`
        )
        .all([listedIds]);
      for (const a of answers) {
        let note = null;
        try { note = JSON.parse(a.metadata || '{}').note || null; } catch { note = null; }
        resubmits.set(a.order_id, { by: a.actor_name, at: a.created_at, note });
      }
    }

    const shape = (o) => {
      const s = summaries.get(o.id);
      return {
        ...o,
        finance_cleared: FINANCE_CONFIRMED.includes(o.status),
        // Decidable between approval and packing, and also while on hold from one of
        // those stages: a Finance hold does not stop Pharmacy.
        reviewable: PHARMACY_STATUSES.includes(o.status) || (o.status === 'on_hold' && PHARMACY_STATUSES.includes(o.held_from)),
        rx_state: s.state,
        prescriptions: s.prescriptions,
        resubmitted: s.state === 'pending' ? resubmits.get(o.id) || null : null,
      };
    };
    const rxRows = orders.map(shape);

    const counts = { pending: 0, rejected: 0, verified: 0, all: rxRows.length, all_orders: allOrdersCount };
    for (const r of rxRows) if (STATES.includes(r.rx_state)) counts[r.rx_state] += 1;

    const shown = wantAllOrders ? listed.map(shape) : wanted === 'all' ? rxRows : rxRows.filter((r) => r.rx_state === wanted);

    res.json({
      success: true,
      data: {
        orders: shown,
        counts,
        can_decide: mayDecide(req.user),
        channels: Object.keys(PHARMACY_CHANNELS),
        channel,
        truncated: wantAllOrders && allOrdersCount > listed.length,
      },
    });
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
    if (!(await isPharmacyReviewable(order))) {
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

// ── The MedRep answers a rejection: POST /api/orders/:id/resubmit-prescription ──
//
// Sep 26, 2026. Goes to PHARMACY only. It changes no order status, does not touch
// Finance's confirmation and does not notify Finance: the two tracks are independent.
//
// A replacement file uploaded from the Attachments tab already answers a rejection
// (see prescriptionService.summarize). This is the other way: the same file, with a
// note ("the quantity is on page 2"), or a replacement plus a note. If the rejected
// file is still the live one it goes back to 'pending', and the pharmacist sees the
// note next to it; the reason it was rejected stays on the order's timeline.
exports.resubmitPrescription = async (req, res, next) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) return fail(res, 400, 'VALIDATION_ERROR', 'Say what has changed, e.g. "Replacement uploaded" or "Quantity is on page 2".');
    if (note.length > 500) return fail(res, 400, 'VALIDATION_ERROR', 'The note is too long (500 characters at most).');

    const order = await loadOrder(req.params.id);
    if (!order) return fail(res, 404, 'NOT_FOUND', 'Order not found');

    const role = String(req.user?.role || '').toLowerCase();
    const mine = order.medrep_id === req.user.id || (order.raised_by_id && order.raised_by_id === req.user.id);
    if (!(role === 'admin' || role === 'management' || (role === 'medrep' && mine))) {
      return fail(res, 403, 'FORBIDDEN', 'Only the MedRep on this order, or Management, can re-submit its prescription.');
    }
    if (!(await isPharmacyReviewable(order))) {
      return fail(res, 409, 'NOT_IN_QUEUE', `This order is at "${order.status}", so its prescription is not being reviewed now.`);
    }

    const rows = await prescriptionRows([order.id]);
    const { state, prescriptions } = summarize(rows);
    const rejectedLive = prescriptions.filter((p) => p.status === 'rejected' && !p.superseded).map((p) => p.id);
    const everRejected = rows.some((r) => r.status === 'rejected');
    if (state !== 'rejected' && !(state === 'pending' && everRejected)) {
      return fail(res, 409, 'NOTHING_TO_RESUBMIT', 'Pharmacy has not rejected a prescription on this order, so there is nothing to re-submit.');
    }

    const actor = await resolveActor(req.user, role === 'medrep' ? 'medrep' : 'management');
    await db.transaction(async () => {
      if (rejectedLive.length) {
        await db
          .prepare(
            `UPDATE payment_proofs
                SET status = 'pending', verified_by = NULL, verified_at = NULL, rejection_reason = NULL
              WHERE id = ANY(?) AND status = 'rejected'`
          )
          .run([rejectedLive]);
      }
      await logEvent({
        orderId: order.id,
        eventType: 'RX_RESUBMITTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Prescription re-submitted to Pharmacy by ${actor.name}: ${note}`,
        metadata: { note, reset: rejectedLive },
      });
    })();

    // Pharmacy only.
    await notify({
      orderId: order.id,
      recipientIds: (await getUserIdsByRole('dispatch')).filter((id) => id !== actor.id),
      message: `Order ${order.getmeds_order_id}: the prescription was re-submitted by ${actor.name} for your review. ${note}`,
      eventType: 'RX_RESUBMITTED',
      orderData: order,
    });

    const s = (await rxSummaries([order.id])).get(order.id);
    res.json({
      success: true,
      data: { id: order.id, rx_state: s.state, prescriptions: s.prescriptions, message: 'Re-submitted: back with Pharmacy for review.' },
    });
  } catch (err) {
    next(err);
  }
};

exports.verify = (req, res, next) => decide(req, res, next, 'verified');
exports.reject = (req, res, next) => decide(req, res, next, 'rejected');
exports.PHARMACY_STATUSES = PHARMACY_STATUSES;
