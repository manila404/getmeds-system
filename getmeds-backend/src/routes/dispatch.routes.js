const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireOrderScope } = require('../middleware/auth');
const c = require('../controllers/dispatch.controller');

router.use(requireAuth);
router.use(requireRole('dispatch', 'admin', 'management'));

// Sep 11, 2026 (Phase C): division-scoped managers may only reach orders in
// their own divisions. No `/:id` route here today. Attached anyway so that the first one added is
// guarded on the day it is written rather than the day somebody notices.
router.param('id', (req, res, next) => requireOrderScope(req, res, next));

// Read-only — dispatch status is driven by Zoho webhooks (see
// webhook.controller.js: Package created / Shipment created), not by a
// local POST action. See dispatch.controller.js header comment.
router.get('/queue', c.getQueue);

module.exports = router;
