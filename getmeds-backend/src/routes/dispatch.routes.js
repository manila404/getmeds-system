const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/dispatch.controller');

router.use(requireAuth);
router.use(requireRole('dispatch', 'admin', 'management'));

// Read-only — dispatch status is driven by Zoho webhooks (see
// webhook.controller.js: Package created / Shipment created), not by a
// local POST action. See dispatch.controller.js header comment.
router.get('/queue', c.getQueue);

module.exports = router;
