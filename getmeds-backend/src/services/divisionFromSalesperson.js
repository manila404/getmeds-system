'use strict';

const { DIVISIONS } = require('../controllers/auth.controller');

/**
 * Recover an order's Division from Zoho's Salesperson string.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * Sep 11, 2026. `orders.division` is NULL on 60,861 of 60,866 orders — only
 * the handful raised inside this app ever set it. Everything imported from
 * Zoho has nothing, because Zoho has no Division field on a Sales Order; what
 * it has is `salesperson_name`, and this org encodes the division into it:
 *
 *     "HOS | LAGUNA"          division HOS
 *     "B2B | RENROSE"         division B2B
 *     "TeleSales Anesthesia | ..."
 *
 * So the division is recoverable for the orders that carry a Salesperson.
 *
 * ── WHAT IT DELIBERATELY WILL NOT DO ────────────────────────────────────────
 *
 * Guess. The prefix is only accepted when it matches a known Division exactly;
 * everything else returns null and the order's division stays NULL:
 *
 *     "Mohit Kumar"     a person, no division recorded  (1,244 orders)
 *     "WEB" / "Shopee" / "Lazada"   sales channels, not divisions
 *     "DSWD" / "PCSO"   programmes that were removed from DIVISIONS
 *     ""                no salesperson at all           (30,854 orders)
 *
 * That last number is the important one. Half the imported history cannot be
 * attributed to any division, and the honest representation of that is NULL —
 * which orderScopeService then shows only to a full-scope manager. Inventing a
 * division to make the numbers look complete would put orders in front of a
 * manager they do not belong to, which is the exact failure this feature is
 * meant to prevent.
 *
 * ── THE SECOND SEGMENT IS NOT A SUB-DIVISION ────────────────────────────────
 *
 * It is a territory for HOS ("HOS | LAGUNA") and a person's name for B2B
 * ("B2B | RENROSE"). The two are indistinguishable by shape, so this does NOT
 * try to fill in sub_division — a name written into that column would be worse
 * than an empty one, because scope rules would then match on it.
 */

/**
 * Longest first, so "TeleSales Anesthesia" is tested before "TeleSales" and
 * "MD Telesales" before anything it contains. Without this, an Anesthesia
 * order silently lands in plain TeleSales.
 */
const BY_LENGTH = [...DIVISIONS].sort((a, b) => b.length - a.length);

/** The part of a Salesperson string before the separator, trimmed. */
function prefixOf(salesperson) {
  const raw = String(salesperson == null ? '' : salesperson).trim();
  if (!raw) return '';
  return raw.split('|')[0].trim();
}

/**
 * The Division this Salesperson string belongs to, or null when it does not
 * name one.
 *
 * Matching is case-insensitive because Zoho holds "Telesales", "TeleSales" and
 * "TELESALES" for the same division, but the value RETURNED is always the
 * canonical spelling from DIVISIONS, so the column ends up with one form.
 */
function divisionFromSalesperson(salesperson) {
  const prefix = prefixOf(salesperson);
  if (!prefix) return null;

  const lower = prefix.toLowerCase();
  for (const d of BY_LENGTH) {
    const dl = d.toLowerCase();
    // Exact, or the division followed by a space — "B2B FILRES BELARMINO" is
    // a B2B order whose separator was simply left out. A bare startsWith
    // would also match "B2Bsomething", which is why the space is required.
    if (lower === dl || lower.startsWith(`${dl} `)) return d;
  }
  return null;
}

module.exports = { divisionFromSalesperson, prefixOf, BY_LENGTH };
