const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const syncJobs = require('../services/syncJobs');

/**
 * GET /api/sync-jobs/:jobId
 *
 * Aug 28, 2026: shared polling endpoint for both the customers and
 * inventory background sync jobs started via POST
 * /api/customers/sync-from-zoho/start and POST /api/inventory/sync-pull/start
 * — one job registry (services/syncJobs.js), one status shape, for both.
 *
 * A job is a transient in-memory progress report, not a durable record —
 * see services/syncJobs.js's doc comment for the retention/404 behavior.
 * This is a pure read: it never calls Zoho and never touches the database
 * itself (the job it reports on may, in the background, but that's driven
 * entirely from the controllers that created it).
 */
router.get('/:jobId', requireAuth, (req, res) => {
  const job = syncJobs.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Sync job not found — it may have finished more than 15 minutes ago, or the server restarted.'
      }
    });
  }
  res.json({ success: true, data: job });
});

module.exports = router;
