const { isDryRunMode, getTestCustomerZohoIds } = require('./zohoTestFlags');

/**
 * Decides whether a Finance or Dispatch action may really write to Zoho.
 *
 * Sep 12, 2026. The two safety tiers in zohoTestFlags.js used to cover only
 * Sales Order creation, which is how dry-run mode came to push TINs, new
 * contacts and attachments to the real org anyway (chapter 11). Every write
 * the new workflow adds goes through here first, so the same switches that
 * protect order creation protect confirming, invoicing, packing, shipping and
 * delivery too.
 *
 *   dry-run  ZOHO_DRY_RUN=true — no request leaves this app; the caller uses a
 *            fabricated result so the rest of the flow still runs.
 *   blocked  ZOHO_TEST_CUSTOMER_IDS is set and this order's customer is not on
 *            it — the action is refused before anything is written anywhere.
 *   live     neither applies — write for real.
 *
 * @param {string|null} customerZohoContactId
 */
function zohoWriteMode(customerZohoContactId) {
  if (isDryRunMode()) return { mode: 'dry-run' };

  const allowed = getTestCustomerZohoIds();
  if (allowed.length && !allowed.includes(customerZohoContactId)) {
    return {
      mode: 'blocked',
      code: 'TEST_CUSTOMER_ONLY',
      message:
        'Zoho changes are currently limited to the designated test customers ' +
        '(ZOHO_TEST_CUSTOMER_IDS), and this order is not for one of them.'
    };
  }
  return { mode: 'live' };
}

module.exports = { zohoWriteMode };
