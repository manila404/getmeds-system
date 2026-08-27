const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/finance.controller');

router.use(requireAuth);
router.use(requireRole('finance', 'admin', 'management'));

// Read-only — Finance verification now happens in Zoho itself (confirm SO ->
// convert to Invoice -> record Customer Payment), which calls back to
// POST /api/webhooks/zoho and updates orders/payments here automatically.
// The verify-payment / sync-payment routes that used to push status from
// this app to Zoho have been retired; these two just show what Zoho already
// reported.
router.get('/queue', c.getQueue);
router.get('/orders/:id/payment', c.getPayment);

module.exports = router;
