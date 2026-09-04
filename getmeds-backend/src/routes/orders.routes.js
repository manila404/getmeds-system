const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/orders.controller');

// All orders routes require authentication
router.use(requireAuth);

// Meta endpoints (customers + products for dropdowns)
router.get('/meta/customers', c.getCustomers);
router.get('/meta/products', c.getProducts);
// Sep 2, 2026: does Zoho know this MedRep's Salesperson name? Zoho has
// Salesperson as a mandatory Sales Order field in this org and matches it by
// name, so the order form checks before the MedRep fills anything in. Any
// authenticated role — an admin submitting on a rep's behalf wants the same
// answer. Read-only towards Zoho.
router.get('/meta/salesperson', c.getSalespersonStatus);
// Sep 2, 2026: the MedRep an admin can raise an order for, in TEST_MODE.
// Returns an empty, disabled list for everyone else — the server decides who
// gets the picker, since the server is what honours `medrep_id` on create.
router.get('/meta/medreps', c.getMedreps);

// Order CRUD
router.get('/', c.getAll);
router.post('/', requireRole('medrep'), c.create);
router.get('/:id', c.getById);
router.get('/:id/events', c.getEvents);
router.post('/:id/submit', requireRole('medrep'), c.submit);
// Manual fallback: pull this order's current Sales Order status straight
// from Zoho and backfill the audit trail if a webhook was missed (backend
// or ngrok not running at the moment Finance confirmed it in Zoho).
router.post('/:id/sync-from-zoho', c.syncFromZoho);
// Aug 30, 2026: manual PUSH of a failed Zoho Sales Order sync, on demand.
// The automatic 30s background retry loop is off by default now (see
// server.js) — this is how a failed sync gets retried instead, one click
// at a time, so failures don't spam the audit timeline while an issue is
// being diagnosed.
router.post('/:id/retry-zoho-sync', c.retryZohoSync);
router.patch('/:id/exception', requireRole('management', 'admin'), c.setException);
// Aug 31, 2026: fix a failed Zoho sync caused by a bad line item (e.g. a
// product Zoho has since marked inactive) — see orders.controller.js's
// updateItems for why this only works before order.zoho_so_id is set.
router.patch('/:id/items', c.updateItems);

// ─── Proof of payment (Sep 4, 2026) ─────────────────────────────────────────
//
// Order-scoped, so they live here rather than on a router of their own — a
// second router mounted at /api carrying /orders/:id/... would sit behind this
// one and depend on requests falling through it, which is fragile for no gain.
//
// No requireRole: attaching a proof is gated by ORDERSHIP, not by role (the
// MedRep the order belongs to, or an admin), which requireRole cannot express.
// That check is in paymentProof.controller.js's canAttach.
//
// Upload is two calls because the file must not pass through this API —
// Vercel caps request bodies at 4.5 MB and a phone photo is routinely larger.
// The browser PUTs to Supabase directly against the signed URL from step 1.
//
// There is no verify here. Finance approves a proof by verifying the ORDER at
// ready_for_finance_verified — see finance.routes.js.
const proof = require('../controllers/paymentProof.controller');
router.post('/:id/payment-proof/upload-url', proof.getUploadUrl);
router.post('/:id/payment-proof', proof.attach);
router.get('/:id/payment-proof', proof.get);

module.exports = router;
