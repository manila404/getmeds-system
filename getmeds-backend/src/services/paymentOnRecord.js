'use strict';

const db = require('../db/database');

/**
 * Has money, or a claim to money, been recorded against this order? Oct 5, 2026.
 *
 * A draft that was paid in advance and then cancelled must leave a record: the
 * customer is owed a refund and Finance has to follow it up. Deleting such an
 * order would erase the only evidence that the customer paid. So two things
 * count as "payment on record":
 *
 *   - a payment proof is attached (and not deleted),
 *   - a payment row on the order is already verified.
 *
 * Oct 29, 2026: Advanced Payment terms no longer count on their own. The terms
 * say how the customer will pay, not that they did: a draft on those terms with
 * no proof and no verified payment has no money behind it, and Management could
 * not delete it (a double entry, for one).
 *
 * Used by the cancel action (a paid draft can only be cancelled "keep record"),
 * the Cancel dialog (to default and disable options), and — later — the
 * automatic deletion, which must refuse any order for which this is true,
 * whichever button was pressed.
 *
 * @returns {{ has: boolean, reasons: string[] }}
 */
// eslint-disable-next-line no-unused-vars -- `order` kept so existing callers need no change
async function paymentOnRecord(orderId, order = null) {
  const reasons = [];

  const proof = await db
    .prepare("SELECT COUNT(*) AS n FROM payment_proofs WHERE order_id = ? AND file_type = 'payment_proof' AND deleted_at IS NULL")
    .get(orderId);
  if (Number(proof?.n) > 0) reasons.push('A payment proof is attached');

  const paid = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'verified'").get(orderId);
  if (Number(paid?.n) > 0) reasons.push('A payment is already verified');

  return { has: reasons.length > 0, reasons };
}

module.exports = { paymentOnRecord };
