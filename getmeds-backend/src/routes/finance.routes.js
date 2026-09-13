const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireOrderScope } = require('../middleware/auth');
const c = require('../controllers/finance.controller');

router.use(requireAuth);
router.use(requireRole('finance', 'admin', 'management'));

// Sep 11, 2026 (Phase C): division-scoped managers may only reach orders in
// their own divisions. Finance's per-order routes are open to `management` too, so a scoped
// manager could otherwise verify or reject payment on an order in a division
// they do not cover. Finance and Dispatch users themselves are unscoped and
// pass straight through.
router.param('id', (req, res, next) => requireOrderScope(req, res, next));

// Read-only — Finance verification now happens in Zoho itself (confirm SO ->
// convert to Invoice -> record Customer Payment), which calls back to
// POST /api/webhooks/zoho and updates orders/payments here automatically.
// The verify-payment / sync-payment routes that used to push status from
// this app to Zoho have been retired; these two just show what Zoho already
// reported.
router.get('/queue', c.getQueue);
router.get('/orders/:id/payment', c.getPayment);

// Sep 1, 2026 (8): the exception to the read-only rule above. Finance
// verification — checking the customer's account before an invoice is raised —
// is the one stage Zoho has no record of, because it is a judgement about the
// account rather than a document. So it is recorded here, by the person who
// made it, and it writes only to this app; nothing is pushed to Zoho.
router.post('/orders/:id/verify', c.verifyAccount);

// Sep 4, 2026: proof of payment. Reject only — there is deliberately no
// approve here.
//
// A proof is the EVIDENCE for the account check above, not a decision beside
// it. Approving it happens inside c.verifyAccount, in the same transaction
// that moves the order to ready_for_draft_invoice, so the two can never
// disagree and an order never has two places to get stuck.
//
// Rejecting IS separate, because it is a different outcome: "this slip is for
// another invoice, send the right one" should not put the whole order on hold
// while a correct one is fetched.
const proof = require('../controllers/paymentProof.controller');
router.post('/orders/:id/payment-proof/reject', proof.reject);

module.exports = router;
