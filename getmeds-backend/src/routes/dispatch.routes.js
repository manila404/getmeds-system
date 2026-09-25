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

// Sep 25, 2026: the pharmacy's prescription queue — orders with a prescription,
// visible from the moment Management approves them (before Finance), with
// verify / reject. See controllers/pharmacy.controller.js.
const pharmacy = require('../controllers/pharmacy.controller');
router.get('/pharmacy/queue', pharmacy.getQueue);
router.post('/pharmacy/orders/:id/verify', pharmacy.verify);
router.post('/pharmacy/orders/:id/reject', pharmacy.reject);

// Sep 15, 2026: new draft Sales Orders and Finance-confirmed orders, the
// printed delivery slip, and "confirmed for delivery" — which only records who
// checked the address and when; it changes no status and writes nothing to
// Zoho, so it works with the workflow switch on or off.
router.get('/recent', c.getRecent);
// Sep 15, 2026: every held order (Dispatch's flag, or On Hold by Finance /
// Management), and Dispatch's own hold — a flag, the order keeps its place.
router.get('/on-hold', c.getOnHold);
router.post('/orders/:id/hold', c.holdOrder);
router.post('/orders/:id/hold/lift', c.liftHold);
router.get('/orders/:id/slip', c.getSlip);
// Sep 25, 2026: the prescription gate. An order whose prescription the
// pharmacist has not verified (or has rejected) cannot be confirmed for
// delivery, given tracking, or moved through the in-app invoice / pack / ship
// steps. Finance's confirmation is already required to reach these; this adds
// the pharmacy's. See services/prescriptionService.js.
const { requireRxCleared } = require('../services/prescriptionService');
router.post('/orders/:id/confirm-delivery', requireRxCleared, c.confirmDelivery);
// Sep 15, 2026: tracking number on hold, with a reason ("Waiting for
// waybill"), and lifting it. Record-only, like the confirmation above.
router.post('/orders/:id/tracking-hold', c.holdTracking);
// The tracking number, typed by Dispatch — saved and sent to the MedRep only;
// Zoho's shipment is still made in Zoho. Ends a hold.
router.post('/orders/:id/tracking', requireRxCleared, c.addTracking);
// Sep 15, 2026: which Dispatch person caters (handles) an order — a label
// others see, not a lock. See services/dispatchCater.js.
router.post('/orders/:id/cater', c.cater);
router.post('/orders/:id/cater/release', c.releaseCater);
router.post('/orders/:id/tracking-hold/release', c.releaseTrackingHold);

// Sep 12, 2026: Dispatch works in Getmeds (GETMEDS_WORKFLOW_V2). Each button
// makes the matching change in Zoho — see services/workflowV2Service.js. With
// the switch off these answer 404 FEATURE_OFF and the queue above stays
// read-only, driven by Zoho webhooks as before.
router.post('/orders/:id/invoice', requireRxCleared, c.createInvoice);
router.post('/orders/:id/pack', requireRxCleared, c.markPacked);
router.post('/orders/:id/ship', requireRxCleared, c.ship);
router.post('/orders/:id/deliver', c.markDelivered);

module.exports = router;
