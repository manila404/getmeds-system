/**
 * Where an order came from: raised in this app, or imported from Zoho.
 *
 * Sep 12, 2026.
 *
 * The Zoho import brought 60,817 historical Sales Orders into this database so
 * reps could see their own record. They are finished business that lives in
 * Zoho. But they arrived carrying real statuses, and four of those statuses
 * are the ones the Finance queue selects on — so Finance opened their page to
 * 138 imported orders and 4 they were actually meant to act on. The work was
 * not missing, it was buried.
 *
 * Origin is derived from the order reference rather than stored in a column:
 *
 *   ZOHO-xxxxx   imported   — minted by zohoOrderImportService
 *   anything else           — raised here (GM-YYYYMMDD-NNNN in production;
 *                             tests mint their own prefixes, and those must
 *                             count as created-here, not imported)
 *
 * Deliberately NOT "starts with GM-": the negative test is the safe one. A new
 * prefix someone adds later defaults to visible-and-actionable, which is a
 * recoverable mistake. Defaulting it to "imported" would silently hide live
 * orders from Finance, which is the failure this module exists to fix.
 *
 * The same rule is enforced in middleware/auth.js (MedReps cannot write to an
 * imported order). It is defined here once so the two cannot drift: a rule
 * that decides both "who may edit this" and "does Finance ever see it" is not
 * one to have two copies of.
 */

const IMPORTED_PREFIX = 'ZOHO-';

/** True when this order reference came from the Zoho import. */
function isImportedRef(getmedsOrderId) {
  return String(getmedsOrderId || '').startsWith(IMPORTED_PREFIX);
}

/**
 * The same test in SQL, for the alias given (e.g. 'o').
 *
 * Returned as a fragment rather than a full clause so callers can use it as a
 * WHERE condition or a SELECTed boolean without restating the LIKE.
 */
function importedSql(alias = 'o') {
  return `${alias}.getmeds_order_id LIKE '${IMPORTED_PREFIX}%'`;
}

/**
 * The three answers a caller may ask for, and what each means:
 *
 *   'getmeds'  raised in this app       — the default everywhere, because it
 *                                         is the work someone has to do
 *   'zoho'     imported from Zoho       — reference, reachable on purpose
 *   'all'      both                     — reconciliation and admin views
 */
const ORIGINS = ['getmeds', 'zoho', 'all'];
const DEFAULT_ORIGIN = 'getmeds';

/** Unknown or absent values fall back to the default rather than erroring. */
function normalizeOrigin(value) {
  const v = String(value || '').trim().toLowerCase();
  return ORIGINS.includes(v) ? v : DEFAULT_ORIGIN;
}

/**
 * A WHERE fragment for the requested origin, or '' for 'all'.
 * Takes no parameters — the prefix is a constant, not user input.
 */
function originSql(origin, alias = 'o') {
  const o = normalizeOrigin(origin);
  if (o === 'all') return '';
  return o === 'zoho' ? importedSql(alias) : `NOT (${importedSql(alias)})`;
}

module.exports = {
  IMPORTED_PREFIX,
  ORIGINS,
  DEFAULT_ORIGIN,
  isImportedRef,
  importedSql,
  normalizeOrigin,
  originSql,
};
