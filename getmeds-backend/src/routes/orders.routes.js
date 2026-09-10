const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, blockMedrepWritesOnImported } = require('../middleware/auth');
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

// Sep 9, 2026: bulk import of every Sales Order that exists in Zoho, with
// each one's trail rebuilt from Zoho's own record (see
// services/zohoOrderImportService.js). Read-only towards Zoho.
//
// Registered ABOVE `/:id` deliberately. Express matches in declaration order,
// so `/import-from-zoho/status` declared after `GET /:id` would be swallowed
// by it and read as "the order whose id is import-from-zoho" — a 404 that
// looks like a missing feature rather than a routing mistake.
//
// Admin/management only: this can create orders and customers in bulk, which
// is not a MedRep's or Finance's decision to make.
router.post('/import-from-zoho/start', requireRole('admin', 'management'), c.startImportJob);
router.get('/import-from-zoho/status', requireRole('admin', 'management'), c.getImportStatus);

// Sep 10, 2026: `blockMedrepWritesOnImported` on every route below that
// CHANGES an order. A MedRep owns their imported Zoho history so they can read
// it; editing it here would silently diverge from the Zoho record everyone
// else works from. Management and admin are unaffected — see the middleware.
//
// Deliberately NOT on the GETs, and not on /sync-from-zoho, which only pulls
// Zoho's own state back down and is how a rep refreshes what they are looking
// at.
// Order CRUD
router.get('/', c.getAll);
// Sep 5, 2026: Both medreps and management can create orders.
// MedReps create their own. Management specifies via medrep_id.
// Sep 9, 2026: 'admin' added. Admin is a superset of management everywhere
// else in this app — approvals, exceptions, the Clients Directory, the Zoho
// import all accept both — and order creation was the one thing it was shut
// out of, with no reason behind it beyond nobody having asked yet.
router.post('/', requireRole('medrep', 'management', 'admin'), c.create);
router.get('/:id', c.getById);
router.get('/:id/events', c.getEvents);
// Sep 5, 2026: Both medreps and management can submit orders.
// Sep 9, 2026: 'admin' added alongside create above. Creating an order you
// then cannot submit is not access to the form, it is a dead end — a draft
// nobody can move.
router.post('/:id/submit', requireRole('medrep', 'management', 'admin'), blockMedrepWritesOnImported, c.submit);
// Sep 7, 2026: a MedRep's submit() stops at 'pending_management_approval'
// instead of reaching Zoho — Management approves or rejects it here before
// it syncs. See orders.controller.js's submit()/approve()/reject(). An
// order Management/admin submitted themselves never reaches this status, so
// these only ever act on a MedRep-raised order.
router.post('/:id/approve', requireRole('management', 'admin'), c.approve);
router.post('/:id/reject', requireRole('management', 'admin'), c.reject);
// Sep 7, 2026 (2): a third outcome — send it back to 'draft' (reason
// required) instead of on hold, so the MedRep (or Management) can fix it
// with updateDetails/updateItems below and resubmit through the gate again.
router.post('/:id/send-back', requireRole('management', 'admin'), c.sendBack);
// Sep 7, 2026 (2): edit order-level fields (delivery/intake info, Division,
// Sub-division, Salesperson) — the non-items counterpart to PATCH
// /:id/items below. No requireRole here either — same as that route, the
// ownership check (MedRep can only edit their own order) lives inside the
// controller, and the "only before Zoho exists" precondition does too.
router.patch('/:id/details', blockMedrepWritesOnImported, c.updateDetails);
// Manual fallback: pull this order's current Sales Order status straight
// from Zoho and backfill the audit trail if a webhook was missed (backend
// or ngrok not running at the moment Finance confirmed it in Zoho).
router.post('/:id/sync-from-zoho', c.syncFromZoho);
// Aug 30, 2026: manual PUSH of a failed Zoho Sales Order sync, on demand.
// The automatic 30s background retry loop is off by default now (see
// server.js) — this is how a failed sync gets retried instead, one click
// at a time, so failures don't spam the audit timeline while an issue is
// being diagnosed.
router.post('/:id/retry-zoho-sync', blockMedrepWritesOnImported, c.retryZohoSync);
router.patch('/:id/exception', requireRole('management', 'admin'), c.setException);
// Aug 31, 2026: fix a failed Zoho sync caused by a bad line item (e.g. a
// product Zoho has since marked inactive) — see orders.controller.js's
// updateItems for why this only works before order.zoho_so_id is set.
router.patch('/:id/items', blockMedrepWritesOnImported, c.updateItems);

// ─── Attachments: proof of payment, and everything else (Sep 4, generalized Sep 5, 2026) ──
//
// Order-scoped, so they live here rather than on a router of their own — a
// second router mounted at /api carrying /orders/:id/... would sit behind this
// one and depend on requests falling through it, which is fragile for no gain.
//
// No requireRole: attaching a file is gated by ORDERSHIP, not by role (the
// MedRep the order belongs to, an admin, or management), which requireRole
// cannot express. That check is in paymentProof.controller.js's canAttach.
//
// Upload is two calls because the file must not pass through this API —
// Vercel caps request bodies at 4.5 MB and a phone photo is routinely larger.
// The browser PUTs to Supabase directly against the signed URL from step 1.
//
// There is no verify here. Finance approves a proof-type attachment by
// verifying the ORDER at ready_for_finance_verified — see finance.routes.js.
//
// Sep 5, 2026: generalized from a single proof-of-payment slot to a typed,
// multi-file "Attach File(s) to Sales Order" list (mirrors Zoho's Sales Order
// screen). New callers should use /attachments*; the old /payment-proof
// paths are kept below, unchanged, as aliases onto the SAME handlers so
// FinanceQueuePage.jsx and anything else written against the old shape keeps
// working with zero changes.
const proof = require('../controllers/paymentProof.controller');
router.post('/:id/attachments/upload-url', blockMedrepWritesOnImported, proof.getUploadUrl);
router.post('/:id/attachments', blockMedrepWritesOnImported, proof.attach);
router.get('/:id/attachments', proof.list);

// Legacy aliases — do not remove without checking FinanceQueuePage.jsx and
// finance.routes.js's reject route, both of which still call these paths.
router.post('/:id/payment-proof/upload-url', blockMedrepWritesOnImported, proof.getUploadUrl);
router.post('/:id/payment-proof', blockMedrepWritesOnImported, proof.attach);
router.get('/:id/payment-proof', proof.get);

module.exports = router;
