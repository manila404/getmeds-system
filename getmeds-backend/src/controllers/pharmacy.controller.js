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
const { syncVerifiedPrescriptionsToZoho } = require('../services/zohoAttachmentSync');

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
    // Same condition without the `p.` alias — used in subqueries that re-alias.
    const excludeDeletedNoAlias = excludeDeleted ? ' AND deleted_at IS NULL' : '';

    // "Needs attention" tab — orders in the all-orders set that have no prescription
    // filed yet AND pharmacy hasn't cleared them. No extra condition is required:
    // any active pharmacy-channel order without a prescription IS a concern, including
    // those with zero attachments (the most critical case — no proof filed at all).
    // No extra params — all ? markers come from allOrdersParams.
    const needsAttentionAnd = `
  AND NOT EXISTS (SELECT 1 FROM payment_proofs p WHERE p.order_id = o.id AND p.file_type = '${RX_FILE_TYPE}'${excludeDeletedNoAlias})
  AND o.rx_not_required_at IS NULL`;

    // Channel pill: one of the six, or none. It narrows every tab.
    const channel = Object.keys(PHARMACY_CHANNELS).find((k) => k.toLowerCase() === String(req.query.channel || '').toLowerCase()) || null;
    const channelAnd = channel ? ' AND o.division = ANY(?)' : '';
    const channelParams = channel ? [PHARMACY_CHANNELS[channel]] : [];

    // Date filter — frontend sends YYYY-MM-DD strings in PHT; backend converts to UTC.
    const rawDateFrom = req.query.date_from ? String(req.query.date_from) : null;
    const rawDateTo = req.query.date_to ? String(req.query.date_to) : null;
    const dateFromUtc = rawDateFrom ? new Date(rawDateFrom + 'T00:00:00+08:00').toISOString() : null;
    const dateToUtc = rawDateTo ? new Date(rawDateTo + 'T23:59:59+08:00').toISOString() : null;
    // Use finance confirmation date when available (it's when the order actively
    // enters Pharmacy's responsibility); fall back to creation date for orders
    // not yet confirmed by Finance. This matches Dispatch's own date filtering
    // so "Today" in Pharmacy and Dispatch refer to the same operational moment.
    const dateAnd = (dateFromUtc ? ' AND COALESCE(o.primary_finance_verified_at, o.created_at) >= ?' : '') +
                    (dateToUtc   ? ' AND COALESCE(o.primary_finance_verified_at, o.created_at) <= ?' : '');
    const dateParams = [...(dateFromUtc ? [dateFromUtc] : []), ...(dateToUtc ? [dateToUtc] : [])];

    const columns = `o.id, o.getmeds_order_id, o.status, o.division, o.total_amount, o.created_at, o.updated_at,
                o.zoho_so_number, o.delivery_notes, o.no_rx_reason,
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
            AND (EXISTS (SELECT 1 FROM payment_proofs p
                          WHERE p.order_id = o.id AND p.file_type = '${RX_FILE_TYPE}'${excludeDeleted})
                 -- Sep 28, 2026: Pharmacy said this one needs no prescription
                 -- (noRxDecision) — it belongs in the queue same as any other
                 -- decided order, not only in "All orders".
                 OR o.rx_not_required_at IS NOT NULL)${channelAnd}${dateAnd}${scopeAnd}
          ORDER BY o.created_at DESC
          LIMIT ${QUEUE_CAP}`
      )
      .all([PHARMACY_STATUSES, PHARMACY_STATUSES, ...channelParams, ...dateParams, ...scopeParams]);

    // "All orders": every order of the six channels, whether or not a prescription
    // is attached, so the pharmacist can look at the items and notes and decide if
    // one is needed. Native GM- orders only, from Sep 12, 2026.
    const allOrdersSql = `${joins}
          WHERE NOT (${importedSql('o')})
            AND o.created_at >= ?
            AND NOT (o.status = ANY(?))
            AND o.division = ANY(?)${channelAnd}${dateAnd}${scopeAnd}`;
    const allOrdersParams = [ALL_ORDERS_SINCE, ALL_ORDERS_EXCLUDED_STATUSES, ALL_ORDERS_DIVISIONS, ...channelParams, ...dateParams, ...scopeParams];
    const allOrdersCount = Number(
      (await db.prepare(`SELECT COUNT(*) AS n ${allOrdersSql}`).get(allOrdersParams)).n
    );
    const needsAttentionCount = Number(
      (await db.prepare(`SELECT COUNT(*) AS n ${allOrdersSql}${needsAttentionAnd}`).get(allOrdersParams)).n
    );

    const wanted = String(req.query.state || 'pending').toLowerCase();
    const wantAllOrders = wanted === 'all_orders';
    const wantNeedsAttention = wanted === 'needs_attention';

    // Pagination — only for the two large paginated tabs.
    const PER_PAGE = 25;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PER_PAGE;

    const listed = wantAllOrders
      ? await db.prepare(`SELECT ${columns} ${allOrdersSql} ORDER BY o.created_at DESC LIMIT ${PER_PAGE} OFFSET ${offset}`).all(allOrdersParams)
      : wantNeedsAttention
        ? await db.prepare(`SELECT ${columns} ${allOrdersSql}${needsAttentionAnd} ORDER BY o.created_at DESC LIMIT ${PER_PAGE} OFFSET ${offset}`).all(allOrdersParams)
        : orders;

    const listedIds = [...new Set([...orders, ...listed].map((o) => o.id))];
    const summaries = await rxSummaries(listedIds);

    // Sep 29, 2026: orders that have non-prescription attachments but no
    // prescription row — the MedRep may have mislabeled a prescription file
    // (e.g. tagged it 'proof_of_payment'). Used in shape() to set the
    // suspicious_attachments flag for the amber badge on the All Orders tab.
    const suspiciousAttachmentIds = new Set();
    if (listedIds.length) {
      const suspRows = await db
        .prepare(
          `SELECT DISTINCT order_id FROM payment_proofs
            WHERE order_id = ANY(?)
              AND file_type != '${RX_FILE_TYPE}'
              AND file_type != 'dispatch_proof'${excludeDeletedNoAlias}`
        )
        .all([listedIds]);
      for (const r of suspRows) suspiciousAttachmentIds.add(r.order_id);
    }

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
        // Sep 28, 2026: Pharmacy's own "no prescription needed" call — who, when, why.
        not_required: s.not_required || null,
        // Sep 29, 2026: order has non-prescription attachments but zero prescription
        // rows — the MedRep may have uploaded the prescription under the wrong type.
        // Only meaningful when rx_state === 'none' (no prescription rows at all).
        suspicious_attachments: s.state === 'none' && suspiciousAttachmentIds.has(o.id),
        // Sep 29, 2026: the MedRep's reason for submitting without a prescription.
        no_rx_reason: o.no_rx_reason || null,
      };
    };
    const rxRows = orders.map(shape);

    // Sep 28, 2026: 'not_required' is its own state (rxSummaries), but it is
    // Pharmacy's decision the same as an actual verify, so it counts and
    // filters as part of the Verified tab rather than needing a fourth tab.
    const bucketOf = (state) => (state === 'not_required' ? 'verified' : state);
    const counts = { pending: 0, rejected: 0, verified: 0, all: rxRows.length, all_orders: allOrdersCount, needs_attention: needsAttentionCount };
    for (const r of rxRows) {
      const bucket = bucketOf(r.rx_state);
      if (STATES.includes(bucket)) counts[bucket] += 1;
    }

    const shown = (wantAllOrders || wantNeedsAttention)
      ? listed.map(shape)
      : wanted === 'all'
        ? rxRows
        : rxRows.filter((r) => bucketOf(r.rx_state) === wanted);

    // Pagination metadata for the two large tabs.
    const paginatedTotal = wantAllOrders ? allOrdersCount : wantNeedsAttention ? needsAttentionCount : null;
    const pagination = paginatedTotal !== null
      ? { page, per_page: PER_PAGE, total: paginatedTotal, pages: Math.max(1, Math.ceil(paginatedTotal / PER_PAGE)) }
      : null;

    res.json({
      success: true,
      data: {
        orders: shown,
        counts,
        can_decide: mayDecide(req.user),
        channels: Object.keys(PHARMACY_CHANNELS),
        channel,
        pagination,
      },
    });
  } catch (err) {
    next(err);
  }
};

async function loadOrder(id) {
  return await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id, o.raised_by_id, o.zoho_so_id, c.name AS customer_name
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

    // Sep 29, 2026: push just-verified prescriptions to Zoho immediately if the
    // Sales Order already exists. Best-effort — a Zoho failure never fails the
    // verify response; the file will be picked up by pushUnsyncedAttachments on
    // the next re-sync if this call misses.
    if (verdict === 'verified' && order.zoho_so_id) {
      syncVerifiedPrescriptionsToZoho(order.id, order.zoho_so_id, ids).catch((err) =>
        console.warn(`[PHARMACY] syncVerifiedPrescriptionsToZoho failed for order ${order.id}:`, err.message)
      );
    }

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

// ── Pharmacy re-reviews its own rejection ───────────────────────────────────
//
// Sep 28, 2026. `decide()` above only ever acts on a 'pending' row, so once
// Pharmacy rejected a prescription the Rejected tab became a dead end — "View
// files" and a static red label, no way to act again even on a second look or
// a rejection made by mistake. This is that second decision: it acts on the
// order's own LIVE rejected row(s) instead (not one a MedRep has already
// answered with a replacement — that one is already `superseded`, and is
// resubmitPrescription's job above, not this one's).
const RE_REVIEW_ACTIONS = ['verify', 'reject', 'reset'];
exports.reReview = async (req, res, next) => {
  try {
    if (!mayDecide(req.user)) {
      return fail(res, 403, 'FORBIDDEN', 'Only the pharmacy (Dispatch) can re-review a prescription.');
    }
    const action = String(req.body?.action || '').trim();
    if (!RE_REVIEW_ACTIONS.includes(action)) {
      return fail(res, 400, 'VALIDATION_ERROR', `action must be one of: ${RE_REVIEW_ACTIONS.join(', ')}.`);
    }
    const reason = String(req.body?.reason || '').trim();
    if (action === 'reject') {
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

    // The order's own live rejection — not a row a MedRep has already
    // answered with a replacement (summarize() already calls that superseded,
    // and it is history, not something this re-review touches).
    const rows = await prescriptionRows([order.id]);
    const { prescriptions } = summarize(rows);
    const liveRejectedIds = prescriptions.filter((p) => p.status === 'rejected' && !p.superseded).map((p) => p.id);
    if (!liveRejectedIds.length) {
      return fail(res, 404, 'NOTHING_TO_REVIEW', 'This order has no open rejection to re-review.');
    }

    const actor = await resolveActor(req.user, 'dispatch');
    const now = new Date().toISOString();
    const newStatus = action === 'verify' ? 'verified' : action === 'reset' ? 'pending' : 'rejected';
    // A reset means nobody has decided yet, same as a fresh upload — clear who/when.
    const stampDecision = action !== 'reset';

    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE payment_proofs
              SET status = ?, verified_by = ?, verified_at = ?, rejection_reason = ?
            WHERE id = ANY(?) AND status = 'rejected'`
        )
        .run(newStatus, stampDecision ? actor.id : null, stampDecision ? now : null, action === 'reject' ? reason : null, [liveRejectedIds]);

      await logEvent({
        orderId: order.id,
        eventType: 'RX_RE_REVIEWED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes:
          action === 'verify'
            ? `Prescription re-reviewed and Verified by ${actor.name}, overriding an earlier rejection.`
            : action === 'reject'
              ? `Prescription re-reviewed by ${actor.name} — still rejected, reason updated: ${reason}`
              : `Prescription re-reviewed by ${actor.name} — reset to Awaiting review for a second look.`,
        metadata: { attachmentIds: liveRejectedIds, action, ...(action === 'reject' ? { reason } : {}) },
      });

      // A verify needs nothing from the MedRep — the order simply proceeds.
      // The other two outcomes are still something for them to know about.
      if (action !== 'verify') {
        await notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_id, order.raised_by_id].filter(Boolean))),
          message:
            action === 'reject'
              ? `The prescription for order ${order.getmeds_order_id} is still rejected by Pharmacy — updated reason: ${reason}.`
              : `Order ${order.getmeds_order_id}: Pharmacy is taking another look at the prescription.`,
          eventType: 'RX_RE_REVIEWED',
          orderData: order,
        });
      }
    })();

    // Sep 29, 2026: same Zoho push as decide() — push the re-reviewed
    // prescription to Zoho if the Sales Order already exists.
    if (action === 'verify' && order.zoho_so_id) {
      syncVerifiedPrescriptionsToZoho(order.id, order.zoho_so_id, liveRejectedIds).catch((err) =>
        console.warn(`[PHARMACY] syncVerifiedPrescriptionsToZoho (re-review) failed for order ${order.id}:`, err.message)
      );
    }

    const s = (await rxSummaries([order.id])).get(order.id);
    res.json({ success: true, data: { id: order.id, rx_state: s.state, prescriptions: s.prescriptions } });
  } catch (err) {
    next(err);
  }
};

// ── An order with NO prescription at all ────────────────────────────────────
//
// Sep 28, 2026. A MedRep who mis-tags the division, or attaches the
// prescription under the wrong category, leaves an order with zero
// prescription rows — it shows up in "All orders" as "No prescription
// uploaded" and otherwise sits there with nothing to press. This is the two
// actions offered on that card: ask the MedRep for one, or say Pharmacy has
// looked and it genuinely does not need one (a hospital PO, an item that
// never carries a prescription).
//
// Unlike verify/reject/reReview above, there is no payment_proofs row to
// flip — 'request' logs and notifies only; 'not_required' sets
// orders.rx_not_required_* (see prescriptionService.js's rxSummaries, which
// reads it back as state 'not_required' only while the order still has no
// file — the moment one is uploaded the ordinary rules take over on their
// own). Refused once a prescription actually exists on the order: that is
// verify/reject/reReview's job, not this one's.
const NO_RX_ACTIONS = ['request', 'not_required'];
exports.noRxDecision = async (req, res, next) => {
  try {
    if (!mayDecide(req.user)) {
      return fail(res, 403, 'FORBIDDEN', 'Only the pharmacy (Dispatch) can decide this.');
    }
    const action = String(req.body?.action || '').trim();
    if (!NO_RX_ACTIONS.includes(action)) {
      return fail(res, 400, 'VALIDATION_ERROR', `action must be one of: ${NO_RX_ACTIONS.join(', ')}.`);
    }
    const reason = String(req.body?.reason || '').trim();
    if (action === 'request' && !reason) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Say what is needed: it is what the MedRep acts on.');
    }
    if (reason.length > 500) return fail(res, 400, 'VALIDATION_ERROR', 'The reason is too long (500 characters at most).');

    const order = await loadOrder(req.params.id);
    if (!order) return fail(res, 404, 'NOT_FOUND', 'Order not found');
    // Sep 29, 2026: noRxDecision is intentionally not gated on isPharmacyReviewable.
    // The "Needs Attention" tab surfaces orders at any status (including pre-approval
    // and post-ship) that have mislabeled attachments or a MedRep no-rx-reason note.
    // Pharmacy should be able to mark those "not required" or request a prescription
    // regardless of where the order currently sits in the pipeline.
    if (order.status === 'deleted') {
      return fail(res, 409, 'NOT_FOUND', 'This order has been deleted.');
    }

    const rows = await prescriptionRows([order.id]);
    if (rows.length) {
      return fail(res, 409, 'HAS_PRESCRIPTION', 'This order already has a prescription on file — use Verify or Reject on it instead.');
    }

    const actor = await resolveActor(req.user, 'dispatch');
    const now = new Date().toISOString();

    if (action === 'not_required') {
      await db
        .prepare('UPDATE orders SET rx_not_required_by = ?, rx_not_required_at = ?, rx_not_required_reason = ? WHERE id = ?')
        .run(actor.id, now, reason || null, order.id);
      await logEvent({
        orderId: order.id,
        eventType: 'RX_NOT_REQUIRED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Pharmacy marked no prescription needed on this order${reason ? `: ${reason}` : ''}.`,
        metadata: reason ? { reason } : {},
      });
    } else {
      // 'request' — also clears any earlier "not required" call: Pharmacy is
      // now saying the opposite, and a stale flag would keep reading as cleared.
      await db
        .prepare('UPDATE orders SET rx_not_required_by = NULL, rx_not_required_at = NULL, rx_not_required_reason = NULL WHERE id = ?')
        .run(order.id);
      await logEvent({
        orderId: order.id,
        eventType: 'RX_REQUESTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Pharmacy asked for a prescription on this order: ${reason}`,
        metadata: { reason },
      });
      await notify({
        orderId: order.id,
        recipientIds: Array.from(new Set([order.medrep_id, order.raised_by_id].filter(Boolean))),
        message: `Order ${order.getmeds_order_id}: Pharmacy needs a prescription — ${reason}. Please upload one.`,
        eventType: 'RX_REQUESTED',
        orderData: order,
      });
    }

    const s = (await rxSummaries([order.id])).get(order.id);
    res.json({ success: true, data: { id: order.id, rx_state: s.state, prescriptions: s.prescriptions, not_required: s.not_required || null } });
  } catch (err) {
    next(err);
  }
};

exports.PHARMACY_STATUSES = PHARMACY_STATUSES;
