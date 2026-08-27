/**
 * Small shared helpers for the two independent safety flags that govern
 * how this app talks to Zoho while testing against the real company org
 * (added Aug 27, 2026). Centralized here so orderIdService.js,
 * orders.controller.js, and customers.controller.js all read the exact
 * same env vars the exact same way — no risk of one file's parsing
 * drifting from another's.
 *
 * ZOHO_DRY_RUN=true
 *   The strongest safety tier. When on, orders.controller.js's create/
 *   submit NEVER call zoho.createSalesOrder() at all — no HTTP request
 *   leaves this app for that call, no matter which customer is picked.
 *   A fully local, fabricated Sales Order response is used instead so the
 *   rest of the app (state machine, notifications, audit trail, frontend)
 *   behaves exactly as if Zoho had answered. Meant for exercising the
 *   whole order-creation flow against REAL customers/inventory (pulled in
 *   read-only via sync-from-zoho / sync-pull) with zero chance of writing
 *   anything to the real Zoho org. Bypasses the single-TEST-customer gate
 *   below entirely, since nothing real can happen either way.
 *
 * ZOHO_TEST_CUSTOMER_ID=<a Zoho contact id>
 *   The narrower tier: Zoho Sales Orders ARE actually created (a real
 *   write to the real org), but only for the one local customer mapped to
 *   this Zoho contact id. See orders.controller.js's checkTestCustomerGate.
 *
 * Precedence: dry run > test-customer gate > normal. Turning a flag off
 * (unsetting the env var) drops to the next tier down automatically.
 */

function isDryRunMode() {
  return (process.env.ZOHO_DRY_RUN || '').trim().toLowerCase() === 'true';
}

function getTestCustomerZohoId() {
  return (process.env.ZOHO_TEST_CUSTOMER_ID || '').trim() || null;
}

module.exports = { isDryRunMode, getTestCustomerZohoId };
