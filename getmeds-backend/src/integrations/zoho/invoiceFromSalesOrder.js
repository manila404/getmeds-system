'use strict';

/**
 * Nov 28, 2026: what an invoice copies from its Sales Order.
 *
 * Until now POST /invoices carried only customer, reference, date, template,
 * custom fields and each line's item/rate/quantity/warehouse/batches. Zoho
 * filled every other field from the CUSTOMER's defaults, not the Sales
 * Order's. On live, for example:
 *   - SO-70713 "Net 15"           -> INV-12844317 "Paid", due the same day
 *   - SO-70708 "Advanced Payment" -> INV-12844315 "net" 60 days
 *   - SO-70713 VAT-inclusive, ₱10,089 -> invoice VAT-exclusive, ₱11,299.68
 *     (12% VAT added on top of prices that already included it)
 *   - the SO's Terms & Conditions and notes never reached the invoice.
 *
 * The rule now: the invoice says what the Sales Order says. Every value below
 * is read from the SO as Zoho returned it (GET /salesorders/{id}).
 */

const hasValue = (v) => v !== undefined && v !== null && v !== '';

function isNonZeroDiscount(d) {
  if (!hasValue(d)) return false;
  const n = parseFloat(String(d).replace('%', ''));
  return Number.isFinite(n) && n !== 0;
}

/**
 * Extra fields for one invoice line, from its SO line. `quantity` is what this
 * invoice takes from the line. A fixed-amount discount covers the whole SO
 * line, so a partial invoice takes the same share of it; a percentage applies
 * as it is.
 */
function invoiceLineFieldsFromSo(li, quantity) {
  const out = {};
  if (hasValue(li.description)) out.description = li.description;
  if (hasValue(li.unit)) out.unit = li.unit;
  // The SO line's own tax. Without it Zoho takes the item's default tax.
  if (hasValue(li.tax_id)) out.tax_id = li.tax_id;
  if (isNonZeroDiscount(li.discount)) {
    const d = li.discount;
    const full = Number(li.quantity || 0);
    out.discount = String(d).includes('%') || !full || quantity >= full
      ? d
      : Math.round((Number(d) * quantity / full) * 100) / 100;
  }
  return out;
}

/** Top-level invoice fields copied from the SO. */
function invoiceFieldsFromSo(so) {
  const out = {};
  const alreadyInvoiced = (so.line_items || []).some((li) => Number(li.quantity_invoiced || 0) > 0);

  // Payment Terms: both fields, exactly as the SO has them. Zoho works the due
  // date out from the day count. 0 is a real day count ("Advanced Payment",
  // "COD" ...), so this checks presence, not truthiness.
  if (hasValue(so.payment_terms)) out.payment_terms = Number(so.payment_terms) || 0;
  if (hasValue(so.payment_terms_label)) out.payment_terms_label = so.payment_terms_label;

  // Whether VAT sits inside the rate or goes on top. Must match the SO, or the
  // same rates give a different total.
  if (typeof so.is_inclusive_tax === 'boolean') out.is_inclusive_tax = so.is_inclusive_tax;
  if (typeof so.is_discount_before_tax === 'boolean') out.is_discount_before_tax = so.is_discount_before_tax;
  if (hasValue(so.discount_type)) out.discount_type = so.discount_type;

  if (hasValue(so.terms)) out.terms = so.terms;
  if (hasValue(so.notes)) out.notes = so.notes;

  // Order-level money (order discount, shipping charge, adjustment) belongs to
  // the order once: first invoice only, so a later partial invoice does not
  // charge or discount it again.
  if (!alreadyInvoiced) {
    if (so.discount_type === 'entity_level' && isNonZeroDiscount(so.discount)) out.discount = so.discount;
    if (Number(so.shipping_charge || 0) !== 0) {
      out.shipping_charge = so.shipping_charge;
      if (hasValue(so.shipping_charge_tax_id)) out.shipping_charge_tax_id = so.shipping_charge_tax_id;
    }
    if (Number(so.adjustment || 0) !== 0) {
      out.adjustment = so.adjustment;
      if (hasValue(so.adjustment_description)) out.adjustment_description = so.adjustment_description;
    }
  }
  return out;
}

module.exports = { invoiceFieldsFromSo, invoiceLineFieldsFromSo };
