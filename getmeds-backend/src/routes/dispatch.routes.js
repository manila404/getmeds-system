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

// Sep 15, 2026: new draft Sales Orders and Finance-confirmed orders, the
// printed delivery slip, and "confirmed for delivery" — which only records who
// checked the address and when; it changes no status and writes nothing to
// Zoho, so it works with the workflow switch on or off.
router.get('/recent', c.getRecent);
router.get('/orders/:id/slip', c.getSlip);
router.post('/orders/:id/confirm-delivery', c.confirmDelivery);
// Sep 15, 2026: tracking number on hold, with a reason ("Waiting for
// waybill"), and lifting it. Record-only, like the confirmation above.
router.post('/orders/:id/tracking-hold', c.holdTracking);
// The tracking number, typed by Dispatch — saved and sent to the MedRep only;
// Zoho's shipment is still made in Zoho. Ends a hold.
router.post('/orders/:id/tracking', c.addTracking);
router.post('/orders/:id/tracking-hold/release', c.releaseTrackingHold);

// Sep 12, 2026: Dispatch works in Getmeds (GETMEDS_WORKFLOW_V2). Each button
// makes the matching change in Zoho — see services/workflowV2Service.js. With
// the switch off these answer 404 FEATURE_OFF and the queue above stays
// read-only, driven by Zoho webhooks as before.
router.post('/orders/:id/invoice', c.createInvoice);
router.post('/orders/:id/pack', c.markPacked);
router.post('/orders/:id/ship', c.ship);
router.post('/orders/:id/deliver', c.markDelivered);

module.exports = router;
