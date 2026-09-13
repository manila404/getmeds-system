/**
 * The switch for the Finance-confirms / Dispatch-in-Getmeds workflow.
 *
 * Sep 12, 2026. The build plan in the field guide's chapter 12 moves two jobs
 * out of Zoho and into this app: Finance confirms the Sales Order from here,
 * and Dispatch creates the invoice, the package, the shipment and the delivery
 * from here, with this app making each change in Zoho.
 *
 * Everything that behaves differently under that plan reads this one function,
 * so the whole change can be switched on, tried with a test customer, and
 * switched off again without a deploy. Off unless GETMEDS_WORKFLOW_V2 is
 * exactly "true" — the same strict reading ZOHO_AUTO_RETRY_ENABLED uses, so a
 * typo leaves today's flow in place rather than half-enabling the new one.
 *
 * Read at call time, not at module load, so tests (and an operator editing the
 * environment) can flip it without restarting anything.
 */
function isWorkflowV2Enabled() {
  return (process.env.GETMEDS_WORKFLOW_V2 || '').trim().toLowerCase() === 'true';
}

module.exports = { isWorkflowV2Enabled };
