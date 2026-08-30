const express = require('express');
const router = express.Router();
const c = require('../controllers/inventory.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

// Aug 27, 2026: 'sync-push' (created/edited items in Zoho) was removed —
// this module is read-only towards Zoho now. sync-pull only reads Zoho
// (listItems) and writes to the LOCAL database; 'adjust' is local-only too.
router.get('/status', requireAuth, c.getInventoryStatus);
router.post('/sync-pull', requireAuth, requireRole('admin', 'management', 'dispatch'), c.syncPullStock);

// Aug 28, 2026: additive background version — starts a job (202 + job_id)
// instead of blocking the request, so the frontend can show a live
// percentage. ?mode=quick|full, same semantics as customers.routes.js's
// sync-from-zoho/start. Poll progress at GET /api/sync-jobs/:jobId.
router.post('/sync-pull/start', requireAuth, requireRole('admin', 'management', 'dispatch'), c.startSyncJob);

router.post('/adjust', requireAuth, requireRole('admin', 'management', 'dispatch'), c.adjustStock);

module.exports = router;
