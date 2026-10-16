'use strict';

/**
 * Oct 16, 2026: "Paid" is a payment term only Finance sets.
 *
 * GM-20260926-0009 went to Zoho as "Advanced Payment" and was hand-edited to
 * "Paid" four minutes after Management approved it, before Finance had
 * confirmed anything. Two guards come out of that:
 *
 *  1. paidTermsRefusal: a MedRep, Team Lead or Management user can't pick or
 *     type "Paid" on an order. An order that already carries it can be saved
 *     with it unchanged (a resubmit must not fail on a value nobody touched).
 *  2. paidBeforeFinance: when Zoho reports the terms flipped to "Paid" while
 *     the order has not been through Finance, Finance is told. Used by both
 *     the webhook and the reconcile, which each see Zoho-side edits.
 */

const PAID_RE = /^\s*paid\s*$/i;
const ROLES_THAT_MAY_SET_PAID = ['finance', 'admin'];

// Statuses before Finance has confirmed the order: "Paid" showing up here is
// somebody doing Finance's job early, so Finance is told.
const BEFORE_FINANCE_STATUSES = new Set([
  'draft', 'pending_management_approval', 'submitted', 'validating', 'so_pending',
  'so_created', 'ready_for_finance_verified', 'on_hold'
]);

const isPaidTerms = (v) => PAID_RE.test(String(v == null ? '' : v));

/** A message when this caller may not set Paid, else null. */
function paidTermsRefusal(role, nextValue, currentValue) {
  if (!isPaidTerms(nextValue)) return null;
  if (isPaidTerms(currentValue)) return null; // unchanged
  if (ROLES_THAT_MAY_SET_PAID.includes(String(role || '').toLowerCase())) return null;
  return 'Payment Terms can\'t be "Paid". Finance marks an order Paid once the payment is confirmed. Choose Advanced Payment, Cash, COD or the terms that apply.';
}

/**
 * Did this set of Zoho-side changes move Payment Terms to "Paid" on an order
 * Finance has not handled yet? `changes` is zohoEditDiffService output.
 */
function paidBeforeFinance(changes, order) {
  const hit = (changes || []).find((c) => c.key === 'payment_terms' && isPaidTerms(c.newValue) && !c.baseline);
  if (!hit) return null;
  if (!BEFORE_FINANCE_STATUSES.has(String((order && order.status) || '').toLowerCase())) return null;
  return hit;
}

/**
 * Tells Finance when Zoho moved Payment Terms to "Paid" ahead of them.
 * Best-effort: a failed notification must never break the sync that found it.
 */
async function alertFinancePaidEarly(order, changes) {
  const hit = paidBeforeFinance(changes, order);
  if (!hit) return false;
  try {
    const { notify, getUserIdsByRole } = require('./notificationService');
    const financeIds = await getUserIdsByRole('finance');
    if (!financeIds.length) return false;
    await notify({
      orderId: order.id,
      recipientIds: financeIds,
      message: `Order ${order.getmeds_order_id} — Payment Terms were changed to "Paid" in Zoho` +
        `${hit.oldValue ? ` (was ${hit.oldValue})` : ''} before Finance confirmed it. Check the payment before verifying.`,
      eventType: 'PAYMENT_TERMS_PAID_EARLY',
      orderData: { ...order }
    });
    return true;
  } catch (err) {
    console.error('[PAID_TERMS] could not alert Finance:', err.message);
    return false;
  }
}

module.exports = { alertFinancePaidEarly, isPaidTerms, paidTermsRefusal, paidBeforeFinance, BEFORE_FINANCE_STATUSES };
