'use strict';

/**
 * Which Division an order belongs to, from the Zoho Salesperson picked on it. Oct 30, 2026.
 *
 * One person can hold Zoho names in two divisions: Nicka holds "CLIDP | NICKA" (her
 * primary) and "MT | 1" (Modern Trade). The order's Division used to come from her
 * account only, so her MT | 1 orders went to Zoho as Division CLIDP.
 *
 * The rule, kept deliberately narrow so nobody's existing orders change:
 *   - the account's own primary name, or no name: the account's Division;
 *   - another name whose prefix ("MT" in "MT | 1") is in the same family as the
 *     account's Division ("TeleSales | AILA" for "TeleSales Anesthesia"): the account's;
 *   - another name whose prefix is a known Division: that Division;
 *   - anything else: the account's.
 *
 * Mirrored in getmeds-frontend/src/constants/divisions.js (divisionForSalesperson).
 */

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** "MT | 1" -> "MT"; "MD Telesales l Juan" -> "MD Telesales"; no separator -> ''. */
function salespersonPrefix(name) {
  const m = String(name || '').match(/^\s*(.+?)\s*(?:\||\sl\s)/);
  return m ? m[1].trim() : '';
}

function divisionForSalesperson({ salesperson, primarySalesperson, accountDivision, divisions }) {
  const account = accountDivision || null;
  if (!salesperson || lc(salesperson) === lc(primarySalesperson)) return account;
  const prefix = lc(salespersonPrefix(salesperson));
  if (!prefix) return account;
  if (account && lc(account).startsWith(prefix)) return account;
  const match = (divisions || []).find((d) => lc(d) === prefix);
  return match || account;
}

module.exports = { divisionForSalesperson, salespersonPrefix };
