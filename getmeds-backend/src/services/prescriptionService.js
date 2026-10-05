'use strict';

/**
 * Prescription verification: what state an order's prescription is in, and the
 * gate that keeps an order from going out until the pharmacist has cleared it.
 *
 * Sep 25, 2026.
 *
 * A prescription is an ordinary attachment (payment_proofs, file_type =
 * 'prescription'). That table already has the columns a review needs -- status
 * pending / verified / rejected, who and when, a rejection reason -- and until
 * now nothing read them for this type (the row just stayed 'pending' forever, by
 * design: see schema.pg.sql). So the pharmacist's decision is stored there, on
 * the file it is about, rather than in a second table that has to be kept in
 * step with it.
 *
 * ── The state of an ORDER ──────────────────────────────────────────────────
 *
 *   none       no prescription on the order (the gate does not apply)
 *   pending    a prescription is waiting for the pharmacist
 *   rejected   the pharmacist sent one back; the MedRep has to replace it
 *   verified   every prescription on the order has been verified
 *
 * An order can carry several prescriptions (a multi-page one is several files),
 * and ALL of them have to be verified. A rejected file that the MedRep has since
 * replaced no longer counts -- otherwise one rejection would block the order
 * forever, since the replacement is a new row and the old one stays 'rejected'
 * as the record of what happened. "Replaced" means a prescription was uploaded
 * after it was rejected.
 *
 * Priority when files disagree: rejected (someone has to act) > pending (waiting
 * on the pharmacist) > verified.
 *
 * ── The gate ───────────────────────────────────────────────────────────────
 * requireRxCleared refuses Dispatch's in-app "going out" actions -- confirming
 * for delivery, adding tracking, and the in-app invoice / pack / ship steps --
 * while the state is pending or rejected. It CANNOT stop a Package or Shipment
 * being created in Zoho Inventory itself, which is outside this app; that is
 * what the badge on the Dispatch board is for.
 */

const db = require('../db/database');
const { hasColumn } = require('./schemaColumns');

const RX_FILE_TYPE = 'prescription';

// Where the prescription still matters: from "Sales Order created, waiting on
// Finance" until the parcel is packed. Once Zoho has shipped an order it is out
// -- pending prescriptions on those (every hospital order that predates this
// review carries one, still 'pending' because nothing ever reviewed it) must not
// block Dispatch adding a tracking number to a parcel that has already left.
const PRE_SHIP_STATUSES = [
  'ready_for_finance_verified',
  'ready_for_draft_invoice',
  'ready_for_invoice_sent',
  'ready_for_dispatch',
  'picking_packing',
];

/** Every live prescription file on these orders, oldest first. */
async function prescriptionRows(orderIds) {
  const ids = [...new Set((orderIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const excludeDeleted = await hasColumn('payment_proofs', 'deleted_at');
  return await db
    .prepare(
      `SELECT p.id, p.order_id, p.status, p.file_name, p.content_type, p.uploaded_at,
              p.verified_at, p.rejection_reason,
              uu.name AS uploaded_by_name, vu.name AS verified_by_name
         FROM payment_proofs p
         LEFT JOIN users uu ON uu.id = p.uploaded_by
         LEFT JOIN users vu ON vu.id = p.verified_by
        WHERE p.order_id = ANY(?) AND p.file_type = '${RX_FILE_TYPE}'${excludeDeleted ? ' AND p.deleted_at IS NULL' : ''}
        ORDER BY p.uploaded_at, p.id`
    )
    .all([ids]);
}

/**
 * Which of a set of prescription rows are superseded — a rejected file with a
 * replacement uploaded after Pharmacy rejected it. Comparing with the
 * rejection time (not the file's own upload time) matters for a multi-page
 * prescription: page B uploaded before page A was rejected is not a
 * replacement for A, and must not quietly clear it.
 *
 * Sep 28, 2026: pulled out of summarize() so paymentProof.controller.js's
 * attachments list can mark the same rows the same way — the order detail
 * screen (Full page / the modal) used to show an old rejected prescription
 * next to its replacement with no way to tell which was current.
 */
function supersededIds(rows) {
  const isSuperseded = (r) =>
    r.status === 'rejected' &&
    Boolean(r.verified_at) &&
    rows.some((x) => x !== r && String(x.uploaded_at || '') > String(r.verified_at));
  return new Set(rows.filter(isSuperseded).map((r) => r.id));
}

/** Pure: one order's rows -> { state, prescriptions }. */
function summarize(rows) {
  if (!rows.length) return { state: 'none', prescriptions: [] };

  const superseded = supersededIds(rows);
  const isSuperseded = (r) => superseded.has(r.id);
  const effective = rows.filter((r) => !isSuperseded(r));

  let state = 'verified';
  if (effective.some((r) => r.status === 'rejected')) state = 'rejected';
  else if (effective.some((r) => r.status === 'pending')) state = 'pending';

  return {
    state,
    prescriptions: rows.map((r) => ({
      id: r.id,
      file_name: r.file_name,
      content_type: r.content_type,
      status: r.status,
      uploaded_at: r.uploaded_at,
      uploaded_by_name: r.uploaded_by_name || null,
      verified_at: r.verified_at || null,
      verified_by_name: r.verified_by_name || null,
      rejection_reason: r.rejection_reason || null,
      // Shown as history rather than as something to act on.
      superseded: isSuperseded(r),
    })),
  };
}

/**
 * Orders Pharmacy has said need no prescription at all (a hospital PO, an item
 * that never carries one — see pharmacy.controller.js's noRxDecision), among
 * the given ids. Only orders with the column set; the caller only applies
 * this while the order still has zero prescription rows (below).
 */
async function notRequiredMap(ids) {
  if (!ids.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT o.id, o.rx_not_required_at, o.rx_not_required_reason, u.name AS by_name
         FROM orders o
         LEFT JOIN users u ON u.id = o.rx_not_required_by
        WHERE o.id = ANY(?) AND o.rx_not_required_at IS NOT NULL`
    )
    .all([ids]);
  return new Map(rows.map((r) => [r.id, { at: r.rx_not_required_at, reason: r.rx_not_required_reason, by: r.by_name || null }]));
}

/**
 * Oct 5, 2026: Pharmacy's latest "Request prescription" per order (the
 * RX_REQUESTED event noRxDecision logs) — who, when, what they asked for.
 */
async function requestedMap(ids) {
  if (!ids.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT DISTINCT ON (order_id) order_id, actor_name, created_at, metadata
         FROM order_events
        WHERE event_type = 'RX_REQUESTED' AND order_id = ANY(?)
        ORDER BY order_id, id DESC`
    )
    .all([ids]);
  return new Map(rows.map((r) => {
    let reason = null;
    try { reason = JSON.parse(r.metadata || '{}').reason || null; } catch { reason = null; }
    return [r.order_id, { at: r.created_at, by: r.actor_name || null, reason }];
  }));
}

/**
 * Map of orderId -> { state, prescriptions, not_required?, requested? } for
 * every id asked about.
 *
 * Sep 28, 2026: `state` can also be 'not_required' — zero prescription rows,
 * and Pharmacy has said none is needed. Only while there is still no file on
 * the order: the moment a MedRep uploads one, the ordinary pending/rejected/
 * verified rules take over on their own, with no separate reset needed.
 *
 * Oct 5, 2026: `requested` — zero prescription rows, not marked "not required",
 * and Pharmacy has asked the MedRep for one. `state` stays 'none' (so the
 * Pharmacy tabs are unchanged), but the order is blocked from going out like a
 * rejected one (requireRxCleared) until a file is uploaded and verified, or
 * Pharmacy marks it not required. A "not required" call clears it, and a new
 * request clears "not required" (noRxDecision), so the latest call wins.
 */
async function rxSummaries(orderIds) {
  const rows = await prescriptionRows(orderIds);
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r);
  }
  const ids = [...new Set((orderIds || []).map(Number))];
  const notRequired = await notRequiredMap(ids);
  // Only orders with no file can have an open request; skip the lookup otherwise.
  const requested = await requestedMap(ids.filter((id) => !byOrder.has(id) && !notRequired.has(id)));

  const out = new Map();
  for (const id of ids) {
    const orderRows = byOrder.get(id) || [];
    const nr = !orderRows.length ? notRequired.get(id) : null;
    if (nr) out.set(id, { state: 'not_required', prescriptions: [], not_required: nr });
    else if (!orderRows.length && requested.has(id)) out.set(id, { state: 'none', prescriptions: [], requested: requested.get(id) });
    else out.set(id, summarize(orderRows));
  }
  return out;
}

/** Oct 5, 2026: true while the order must not go out for prescription reasons. */
function rxBlocks(summary) {
  return !!summary && (summary.state === 'pending' || summary.state === 'rejected' || !!summary.requested);
}

/**
 * What the Dispatch board should say about an order, given the prescription and
 * where Finance is. null when there is no prescription (nothing to say).
 * `tone` is for the badge colour: ok / wait / block.
 */
function rxBadge(rxState, financeCleared, requested = null) {
  // Oct 5, 2026: Pharmacy asked the MedRep for a prescription and none is on file yet.
  if (requested && (!rxState || rxState === 'none')) {
    return { tone: 'block', label: financeCleared ? 'Finance Confirmed — Rx Requested from MedRep' : 'Rx Requested from MedRep' };
  }
  if (!rxState || rxState === 'none') return null;
  if (rxState === 'not_required') {
    return financeCleared
      ? { tone: 'ok', label: 'Rx Not Required + Finance Confirmed — clear to dispatch' }
      : { tone: 'wait', label: 'Rx Not Required — Awaiting Finance' };
  }
  if (rxState === 'rejected') {
    return {
      tone: 'block',
      label: financeCleared
        ? 'Finance Confirmed — Rx Rejected, waiting for replacement'
        : 'Rx Rejected — waiting for replacement',
    };
  }
  if (rxState === 'verified') {
    return financeCleared
      ? { tone: 'ok', label: 'Rx Verified + Finance Confirmed — clear to dispatch' }
      : { tone: 'wait', label: 'Rx Verified — Awaiting Finance' };
  }
  // pending
  return financeCleared
    ? { tone: 'block', label: 'Finance Confirmed — Awaiting Rx Verification' }
    : { tone: 'wait', label: 'Awaiting Rx Verification and Finance' };
}

const NOT_CLEARED_MESSAGE = {
  pending: 'This order has a prescription the pharmacist has not verified yet. It cannot go out until they do.',
  rejected: 'The prescription on this order was rejected and has not been replaced yet. It cannot go out until a new one is verified.',
  requested: 'Pharmacy asked the MedRep for a prescription on this order and none has been uploaded yet. It cannot go out until one is verified, or Pharmacy marks it not required.',
};

/** Express middleware: 409 while the order's prescription is pending, rejected, or requested by Pharmacy. */
function requireRxCleared(req, res, next) {
  (async () => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return next();
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    if (!order || !PRE_SHIP_STATUSES.includes(order.status)) return next();
    const summary = (await rxSummaries([id])).get(id);
    if (rxBlocks(summary)) {
      const key = summary.requested ? 'requested' : summary.state;
      return res.status(409).json({
        success: false,
        error: { code: 'RX_NOT_VERIFIED', message: NOT_CLEARED_MESSAGE[key], rx_state: summary.state, rx_requested: !!summary.requested },
      });
    }
    return next();
  })().catch(next);
}

// ── Sep 26, 2026: Pharmacy and Finance are two independent tracks ─────────────
//
// A prescription rejected by Pharmacy is answered by the MedRep to PHARMACY
// (a replacement upload, or "Resubmit prescription" with a note), and that never
// touches Finance: the order's status is not changed, Finance's confirmation is
// not reset, Finance is not notified. The mirror image holds too: answering a
// Finance hold (returnToFinanceIfHeld) never changes a prescription's state.

/** The stage an order was at just before its latest hold, or null. */
async function heldFromStage(orderId) {
  const row = await db
    .prepare(
      `SELECT old_status FROM order_events
        WHERE order_id = ? AND new_status = 'on_hold' AND old_status <> 'on_hold'
        ORDER BY id DESC LIMIT 1`
    )
    .get(orderId);
  return row ? row.old_status : null;
}

/**
 * Can the pharmacist decide on this order's prescription? From Management's approval
 * until packing, and also while the order is on hold from one of those stages: a
 * Finance hold must not stop Pharmacy working its own track.
 */
async function isPharmacyReviewable(order) {
  if (!order) return false;
  if (PRE_SHIP_STATUSES.includes(order.status)) return true;
  if (order.status === 'on_hold') return PRE_SHIP_STATUSES.includes(await heldFromStage(order.id));
  return false;
}

/**
 * What the MedRep needs to see when Pharmacy rejected the prescription, or
 * (Oct 5, 2026) asked for one on an order that has none:
 * { state, rejection: { reason, at, file_name } | null, requested: { reason, at, by } | null, can_resubmit }.
 */
async function rxStatusForOrder(order) {
  const { state, prescriptions, requested } = (await rxSummaries([order.id])).get(order.id);
  const live = prescriptions.filter((p) => !p.superseded && p.status === 'rejected');
  const last = live.sort((a, b) => String(b.verified_at || '').localeCompare(String(a.verified_at || '')))[0] || null;
  return {
    state,
    rejection: last ? { reason: last.rejection_reason, at: last.verified_at, file_name: last.file_name } : null,
    requested: requested || null,
    can_resubmit: (state === 'rejected' || !!requested) && (await isPharmacyReviewable(order)),
  };
}

module.exports = {
  RX_FILE_TYPE, PRE_SHIP_STATUSES, summarize, rxSummaries, rxBadge, rxBlocks, requireRxCleared,
  heldFromStage, isPharmacyReviewable, rxStatusForOrder, prescriptionRows, supersededIds,
};
