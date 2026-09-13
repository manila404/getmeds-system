const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireOrderScope } = require('../middleware/auth');
const c = require('../controllers/dispatch.controller');

router.use(requireAuth);
router.use(requireRole('dispatch', 'admin', 'management'));

// Sep 11, 2026 (Phase C): division-scoped managers may only reach orders in
// their own divisions. Attached before any `/:id` route existed so that the
// first one added would be guarded on the day it was written — which, as of
// Sep 12, is the four actions below.
router.param('id', (req, res, next) => requireOrderScope(req, res, next));

router.get('/queue', c.getQueue);

// Sep 12, 2026: Dispatch works in Getmeds (GETMEDS_WORKFLOW_V2). Each button
// makes the matching change in Zoho — see services/workflowV2Service.js. With
// the switch off these answer 404 FEATURE_OFF and the queue above stays
// read-only, driven by Zoho webhooks as before.
router.post('/orders/:id/invoice', c.createInvoice);
router.post('/orders/:id/pack', c.markPacked);
router.post('/orders/:id/ship', c.ship);
router.post('/orders/:id/deliver', c.markDelivered);

module.exports = router;
