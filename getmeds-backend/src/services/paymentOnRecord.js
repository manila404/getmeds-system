'use strict';

const db = require('../db/database');

/**
 * Has money, or a claim to money, been recorded against this order? Oct 5, 2026.
 *
 * A draft that was paid in advance and then cancelled must leave a record: the
 * customer is owed a refund and Finance has to follow it up. Deleting such an
 * order would erase the only evidence that the customer paid. So three things
 * count as "payment on record":
 *
 *   - a payment proof is attached (and not deleted),
 *   - the order's payment terms are Advanced Payment,
 *   - a payment row on the order is already verified.
 *
 * Used by the cancel action (a paid draft can only be cancelled "keep record"),
 * the Cancel dialog (to default and disable options), and — later — the
 * automatic deletion, which must refuse any order for which this is true,
 * whichever button was pressed.
 *
 * @returns {{ has: boolean, reasons: string[] }}
 */
async function paymentOnRecord(orderId, order = null) {
  const o = order || (await db.prepare('SELECT id, intake_payment_terms FROM orders WHERE id = ?').get(orderId));
  const reasons = [];

  const proof = await db
    .prepare("SELECT COUNT(*) AS n FROM payment_proofs WHERE order_id = ? AND file_type = 'payment_proof' AND deleted_at IS NULL")
    .get(orderId);
  if (Number(proof?.n) > 0) reasons.push('A payment proof is attached');

  if (o && /advance/i.test(String(o.intake_payment_terms || ''))) reasons.push('Payment terms are Advanced Payment');

  const paid = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'verified'").get(orderId);
  if (Number(paid?.n) > 0) reasons.push('A payment is already verified');

  return { has: reasons.length > 0, reasons };
}

module.exports = { paymentOnRecord };
