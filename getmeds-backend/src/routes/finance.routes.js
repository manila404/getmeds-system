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
// Sep 19, 2026: "each finance can see their approved/verified SO, filter it
// one day (today) and can select dates" — the signed-in user's OWN
// confirmations only; see the handler's own header for why this stays
// personal rather than a roll-up across Finance users.
router.get('/my-confirmations', c.getMyConfirmations);
// Sep 19, 2026: "create a report tab so the finance can see these details" —
// sales by salesperson, built from this app's own orders. See the
// handler's own header for why it isn't a reproduction of Zoho's report.
router.get('/reports/sales-by-salesperson', c.getSalesBySalesperson);
router.get('/orders/:id/payment', c.getPayment);

// Sep 1, 2026 (8): the exception to the read-only rule above. Finance
// verification — checking the customer's account before an invoice is raised —
// is the one stage Zoho has no record of, because it is a judgement about the
// account rather than a document. So it is recorded here, by the person who
// made it.
//
// Sep 12, 2026: it now also CONFIRMS the Sales Order in Zoho. The line that
// used to end this note — "nothing is pushed to Zoho" — stopped being true.
// Every Sales Order this app creates is a Draft, and a Draft cannot be
// invoiced or packed, so a verification that pushed nothing released nothing.
// See verifyAccount, and ZohoAdapter.confirmSalesOrder for why that write is
// allowed where pack/ship/payment still are not.
router.post('/orders/:id/verify', c.verifyAccount);

// Sep 12, 2026: lift a hold Finance itself applied and put the order back in
// the queue. The MedRep can already do this by attaching or correcting
// something; this is for when Finance resolves the account themselves and
// would otherwise have to ask the rep to touch the order so it reappears.
router.post('/orders/:id/reopen', c.reopenForVerification);

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
