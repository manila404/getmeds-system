/**
 * Order line arithmetic and tax labels, shared by every screen that prices a
 * line.
 *
 * Sep 14, 2026. Moved here from OrderForm.jsx when the order page's item
 * editor was rebuilt to look like the order form. Two screens pricing lines
 * with two copies of this would drift — and the server recomputes every total
 * (backend services/lineAmounts.js), so any difference shows one amount on
 * screen and stores another.
 *
 * Mirrors services/lineAmounts.js exactly:
 *   exclusive  VAT is added on top of the discounted line
 *   inclusive  the rate already contains VAT; the tax is the part that is VAT
 */

export const TAX_OPTIONS = [
  { value: 'none', label: 'No Tax', percent: 0 },
  { value: 'vat12', label: 'VAT 12%', percent: 12 },
  { value: 'zero_rated', label: 'Zero-Rated (0%)', percent: 0 },
  { value: 'vat_exempt', label: 'VAT-Exempt', percent: 0 }
];

export const getTaxOption = (value) => TAX_OPTIONS.find((t) => t.value === value) || TAX_OPTIONS[0];

/**
 * Sep 18, 2026: which TAX_OPTIONS preset a product's own Zoho tax (percent +
 * name) most likely means, so the tax select on a freshly-added item starts
 * on a sensible choice instead of always defaulting to "No Tax". A guess,
 * not a fact — Zoho's real name for a 0% item ("Zero-Rated" vs "VAT-Exempt"
 * vs "No Tax") decides between the three 0% presets; anything else at 0%
 * falls back to "No Tax".
 */
export const inferTaxOption = (percent, label) => {
  if (Number(percent) === 12) return 'vat12';
  const name = String(label || '').toLowerCase();
  if (name.includes('zero')) return 'zero_rated';
  if (name.includes('exempt')) return 'vat_exempt';
  return 'none';
};

// A line's tax as Zoho has it for that item — "Vat (12%)", "No Tax (0%)" — or,
// for a product not yet pulled from Zoho, the old preset.
export const lineTaxLabel = (item) =>
  item.taxLabel != null
    ? `${item.taxLabel}${item.taxPercent != null ? ` (${Number(item.taxPercent)}%)` : ''}`
    : getTaxOption(item.taxOption).label;

export const computeLineAmounts = (item, inclusive = false) => {
  const qty = Number(item.quantity) || 0;
  const rate = Number(item.rate) || 0;
  const subtotal = qty * rate;
  const discount = Math.min(subtotal, Math.max(0, Number(item.discount) || 0));
  const net = subtotal - discount;
  const taxPercent = item.taxPercent != null ? Number(item.taxPercent) : getTaxOption(item.taxOption).percent;
  if (inclusive) {
    const taxAmount = taxPercent > 0 ? (net * taxPercent) / (100 + taxPercent) : 0;
    return { subtotal, discount, taxAmount, amount: net };
  }
  const taxAmount = net * (taxPercent / 100);
  return { subtotal, discount, taxAmount, amount: net + taxAmount };
};
