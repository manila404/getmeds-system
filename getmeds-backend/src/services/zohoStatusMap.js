'use strict';

/**
 * Translating Zoho's four status axes into this app's single workflow status.
 *
 * Sep 10, 2026. Written after comparing the imported orders against the live
 * org and finding 58,289 of them — orders Zoho reports as finished — sitting in
 * this app at 'ready_for_finance_verified', the very first stage after the
 * Sales Order exists. Not one order was marked completed.
 *
 * ── WHY IT WAS WRONG ────────────────────────────────────────────────────────
 *
 * The import read `salesorder.status` and nothing else. But `status` is only a
 * ROLLUP; Zoho tracks four independent axes underneath it:
 *
 *   order_status     draft -> open -> closed
 *   invoiced_status  not_invoiced -> partially_invoiced -> invoiced
 *   paid_status      unpaid -> partially_paid -> paid
 *   shipped_status   not_shipped -> partially_shipped -> shipped -> fulfilled
 *
 * The reconcile then tried to recover the rest by looking for `packages[]` and
 * a tracking number — and in this org, plenty of shipped orders have neither.
 * SO-61582 is invoiced, paid and `shipped_status: fulfilled` with ZERO packages
 * and no tracking number; the shipment lives on the Sales Order itself as
 * `shipment_date` + `delivery_method: Lalamove`. So the dispatch checkpoint
 * never fired, and because completion needs shipped AND paid, nothing ever
 * completed.
 *
 * All four axes come back in Zoho's LIST response, which costs one request per
 * 200 orders. Reading them there rather than inferring from a per-order detail
 * fetch is the difference between ~330 API calls and ~121,000.
 */

/** Zoho's own end state, confirmed with the business as genuinely "done". */
const DONE_STATUSES = ['fulfilled', 'closed'];
const VOID_STATUSES = ['void', 'voided', 'cancelled'];

const lower = (v) => String(v || '').trim().toLowerCase();

/**
 * The local workflow status an order should have, given what Zoho says.
 *
 * Checked most-advanced-first, because the axes overlap: a fulfilled order is
 * also invoiced and also shipped, and the furthest point it has reached is the
 * one worth showing.
 *
 * Returns null when Zoho gives nothing to go on, so a caller can leave the
 * order exactly as it is rather than move it somewhere on no evidence.
 */
function statusFromZoho(so = {}) {
  const status = lower(so.status);
  const order = lower(so.order_status);
  const invoiced = lower(so.invoiced_status);
  const paid = lower(so.paid_status);
  const shipped = lower(so.shipped_status);

  if (VOID_STATUSES.includes(status) || VOID_STATUSES.includes(order)) return 'cancelled';

  // Confirmed with the business (Sep 10, 2026): `status: fulfilled` with
  // `order_status: closed` means the order is finished — invoiced, paid and
  // out the door. Either one alone is treated as done because the sample of
  // the live org showed them always travelling together.
  if (DONE_STATUSES.includes(status) || DONE_STATUSES.includes(order) || shipped === 'fulfilled') {
    return 'completed';
  }

  if (['shipped', 'partially_shipped'].includes(shipped)) return 'dispatched';

  // Invoiced but not yet shipped: the goods are what everyone is waiting on.
  if (['invoiced', 'partially_invoiced'].includes(invoiced)) return 'ready_for_dispatch';

  // Draft in Zoho is a Sales Order that exists and has been confirmed by
  // nobody. It is where an order this app creates starts, too.
  if (order === 'draft' || status === 'draft') return 'so_created';

  // Open, nothing else done yet. This is the one stage that is OURS rather
  // than Zoho's — see FINANCE_VERIFICATION_NOTE below.
  if (order === 'open' || status === 'confirmed' || status === 'open') {
    return 'ready_for_finance_verified';
  }

  return null;
}

/**
 * Why an imported order shows Finance Verification as not done in this app.
 *
 * `ready_for_finance_verified` has no counterpart in Zoho. It is a step this
 * app INTRODUCES: today the check happens as a conversation on a Google chat
 * thread, and centralising it here is the point of building this.
 *
 * That means an order imported from Zoho genuinely never passed through it,
 * and must not be shown as though it had. Every imported order carries this
 * note instead, so anyone auditing one can see where the verification actually
 * lives rather than assuming it was skipped by accident.
 */
const FINANCE_VERIFICATION_NOTE =
  'Finance verification for this order was handled on the Google chat thread, ' +
  'not in this app — it predates the in-app verification step. Check the Google ' +
  'thread for the approval. New orders raised here are verified in the app.';

/** The four axes, as they should be stored on the order. */
function zohoStatusFields(so = {}) {
  return {
    zoho_so_status: lower(so.status) || null,
    zoho_order_status: lower(so.order_status) || null,
    zoho_invoiced_status: lower(so.invoiced_status) || null,
    zoho_paid_status: lower(so.paid_status) || null,
    zoho_shipped_status: lower(so.shipped_status) || null
  };
}

module.exports = {
  statusFromZoho,
  zohoStatusFields,
  FINANCE_VERIFICATION_NOTE,
  DONE_STATUSES,
  VOID_STATUSES
};
