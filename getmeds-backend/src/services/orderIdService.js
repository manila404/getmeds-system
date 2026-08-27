const db = require('../db/database');
const { isDryRunMode, getTestCustomerZohoId } = require('./zohoTestFlags');

/**
 * Generates a unique Getmeds Order ID. Three tiers, most-restrictive-wins
 * (see zohoTestFlags.js for the full explanation of each flag):
 *  1. ZOHO_DRY_RUN=true            -> DryGM-YYYYMMDD-XXXX (nothing ever
 *     reaches Zoho for this order — checked first, highest priority)
 *  2. ZOHO_TEST_CUSTOMER_ID set    -> TestGM-YYYYMMDD-XXXX (a real Zoho
 *     write, but only for the one designated TEST customer)
 *  3. Neither set                  -> GM-YYYYMMDD-XXXX (normal)
 * This id becomes the Sales Order's reference_number and flows into its
 * notes (see LiveZohoAdapter / MockZohoAdapter createSalesOrder, which
 * prepend "TEST — DO NOT FULFILL" to the notes for a TestGM- id). Turning
 * a flag off drops new orders to the next tier down automatically — no
 * separate switch to remember to flip back.
 * Uses DB sequence for the day to ensure uniqueness.
 */
function generateOrderId() {
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const tierPrefix = isDryRunMode() ? 'DryGM' : (getTestCustomerZohoId() ? 'TestGM' : 'GM');
  const prefix = `${tierPrefix}-${yyyymmdd}-`;

  // Find the highest sequence for today
  const row = db.prepare(
    `SELECT getmeds_order_id FROM orders WHERE getmeds_order_id LIKE ? ORDER BY getmeds_order_id DESC LIMIT 1`
  ).get(`${prefix}%`);

  let seq = 1;
  if (row) {
    const lastSeq = parseInt(row.getmeds_order_id.split('-')[2], 10);
    seq = lastSeq + 1;
  }

  return `${prefix}${seq.toString().padStart(4, '0')}`;
}

module.exports = { generateOrderId };
