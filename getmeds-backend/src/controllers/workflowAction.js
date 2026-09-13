const { WorkflowError } = require('../services/workflowV2Service');
const { isWorkflowV2Enabled } = require('../services/workflowFlags');

/**
 * Sep 12, 2026: the HTTP side of every Finance-confirm and Dispatch button
 * (services/workflowV2Service.js), in one place so the Finance and Dispatch
 * controllers answer the same way.
 *
 *   - Switch off (GETMEDS_WORKFLOW_V2 unset): 404 FEATURE_OFF. The routes are
 *     registered either way; with the switch off they do nothing at all, so the
 *     live flow — confirming and dispatching inside Zoho — is untouched.
 *   - A WorkflowError carries its own status and code ("someone else is already
 *     on this order", "voided in Zoho"...) and goes back as-is, for the page to
 *     show the person.
 *   - Anything else is a real fault and goes to the normal error handler.
 */
function workflowAction(run) {
  return async (req, res, next) => {
    if (!isWorkflowV2Enabled()) {
      return res.status(404).json({
        success: false,
        error: { code: 'FEATURE_OFF', message: 'This action is not switched on yet. Confirm and dispatch in Zoho as usual.' }
      });
    }
    try {
      const data = await run(req);
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof WorkflowError) {
        return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
      }
      next(err);
    }
  };
}

module.exports = { workflowAction };
