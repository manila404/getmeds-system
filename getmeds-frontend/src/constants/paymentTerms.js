/**
 * Payment Terms — mirrors the exact list configured on Zoho's own Sales
 * Order screen (free text with suggestions, not a locked dropdown, since
 * Zoho's own field accepts a custom typed value too — there's no Zoho
 * Inventory API to read this list live, checked Sep 5, 2026: only an
 * undocumented, Books-only settings endpoint exists, not guaranteed to
 * work or stay working — so hardcoding stays the right call). Refreshed
 * Sep 5, 2026 against the org's current dropdown, kept in Zoho's own
 * display order. 'net' (lowercase) is listed twice in Zoho itself,
 * alongside 'Net' — kept as two separate suggestions since that's
 * genuinely what's configured there, not a typo on this end.
 *
 * Sep 18, 2026: pulled out of OrderForm.jsx into its own file — it was
 * ALSO hand-copied into OrderDetailPage.jsx's draft-edit form, identical
 * at the time but with no shared source, so the two could only ever drift
 * apart the next time either list changed. One export now, imported by
 * both.
 *
 * Sep 19, 2026: PDC (Post-Dated Cheque) and NET added as their own
 * explicit, symmetric presets — "PDC 30" / "NET 30" and so on — alongside
 * Zoho's own list rather than in place of it. Zoho's list already has
 * several net-terms spellings ("Net 15", "30 days", "60 Day"...) but
 * nothing that distinguishes a post-dated cheque arrangement from a
 * straight net term, and the two mean different proof of payment: a PDC
 * term is settled by a cheque dated for later, a NET term is usually a
 * bank transfer once it's due. See paymentTermsProofHint below.
 */
const PDC_NET_SUGGESTIONS = ['PDC 15', 'PDC 30', 'PDC 45', 'PDC 60', 'NET 15', 'NET 30', 'NET 45', 'NET 60'];

export const PAYMENT_TERMS_SUGGESTIONS = [
  ...PDC_NET_SUGGESTIONS,
  'Due end of next month',
  'Due end of the month',
  'Paid',
  'Advanced Payment',
  'Advanced Payment - Partial',
  'Donation/Charity',
  'Samples',
  'Due on Receipt',
  '60% DP 40% UPON DEL',
  'CASH',
  'COD',
  'Net',
  'Net 15',
  '30 days',
  '45 Day',
  'BPO WALLET',
  '60 Day',
  'DSWD/PCSO',
  'net',
  'OP',
  '90 Day',
  'INITIAL STOCKING',
  '120 Day',
  '180 Day'
];

/**
 * What to attach as proof, for whichever of PDC/NET is in the typed terms
 * — or null for anything else (Zoho's other presets: CASH, COD, Donation,
 * Samples...) since none of those carry the same PDC-vs-NET ambiguity.
 */
export const paymentTermsProofHint = (terms) => {
  const t = String(terms || '').toLowerCase();
  if (/\bpdc\b/.test(t)) return '📋 PDC terms — attach a clear photo of the post-dated cheque as proof of payment.';
  if (/\bnet\b/.test(t)) return '🏦 NET terms — usually settled by bank transfer; attach the deposit slip or transfer receipt as proof of payment.';
  return null;
};
