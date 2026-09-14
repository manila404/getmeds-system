/**
 * What one order line costs: its discount, its tax, and its total.
 *
 * Sep 14, 2026. Written once, here, because the same five lines of arithmetic
 * were copied into both order-create and updateItems in orders.controller.js,
 * and adding Tax Inclusive to one copy without the other would have produced
 * an order whose total changed the first time someone edited its items.
 *
 * Two tax preferences, matching Zoho's own "Item Tax Preference":
 *
 *   exclusive  the rate is BEFORE tax. VAT is added on top of the discounted
 *              amount:     total = (qty x rate - discount) x (1 + p/100)
 *
 *   inclusive  the rate ALREADY CONTAINS tax. The line total is simply the
 *              discounted amount, and the tax is the part of it that is VAT:
 *              tax = total x p / (100 + p)
 *
 * The discount is always taken off before tax is worked out, and is capped at
 * the line's subtotal so a discount larger than the line cannot produce a
 * negative total — both unchanged from the arithmetic this replaces.
 */

/** Accepts the shapes a JSON body or a form might send for "yes". */
function parseInclusiveTax(value) {
  if (value === true || value === 1) return true;
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'inclusive';
}

/**
 * @param {object} args
 * @param {number} args.subtotal   quantity x rate
 * @param {*}      args.discount   flat amount off the line; blank means none
 * @param {*}      args.taxPercent e.g. 12 for VAT 12%; blank means none
 * @param {boolean} args.inclusive whether the rate already contains the tax
 */
function computeLine({ subtotal, discount, taxPercent, inclusive = false }) {
  const discountAmount = Math.min(subtotal, Math.max(0, Number(discount) || 0));
  const pct = Math.max(0, Number(taxPercent) || 0);
  const net = subtotal - discountAmount;

  if (inclusive) {
    const taxAmount = pct > 0 ? (net * pct) / (100 + pct) : 0;
    return { discountAmount, taxPercent: pct, taxAmount, lineTotal: net };
  }

  const taxAmount = net * (pct / 100);
  return { discountAmount, taxPercent: pct, taxAmount, lineTotal: net + taxAmount };
}

module.exports = { computeLine, parseInclusiveTax };
