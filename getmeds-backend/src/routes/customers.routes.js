const express = require('express');
const router = express.Router();
const c = require('../controllers/customers.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

// Admin/management overview of local customers (the Clients Directory),
// tagged with Zoho origin, Credit/Direct type, local category, and which
// one (if any) is the designated TEST customer. Not used by the MedRep
// order form (that uses /api/orders/meta/customers instead), so it's safe
// to restrict to admin/management.
router.get('/', requireAuth, requireRole('admin', 'management'), c.getCustomersOverview);

// Sep 11, 2026: create a customer that does not exist in Zoho yet.
//
// MedRep as well as admin/management, and that is the point of the feature: a
// rep taking an order from a new pharmacy could not place it at all, because
// createSalesOrder needs a Zoho contact id and there was no way to get one.
// Finance and Dispatch are left out — they work orders, they do not open
// accounts.
router.post('/', requireAuth, requireRole('medrep', 'admin', 'management'), c.createCustomer);

// Sep 11, 2026: customers saved here that Zoho has not accepted yet.
//
// Declared ABOVE any '/:id' route — Express matches in declaration order, so
// '/pending' below one of those would be read as "the customer whose id is
// pending". Admin/management only: pushing to Zoho is not a MedRep's call,
// even though creating the held customer was.
router.get('/pending', requireAuth, requireRole('admin', 'management'), c.listPendingCustomers);
router.post('/pending/sync', requireAuth, requireRole('admin', 'management'), c.syncPendingCustomers);
// Put a customer wrongly marked 'Needs attention' back in the queue.
router.post('/:id/retry', requireAuth, requireRole('admin', 'management'), c.retryPendingCustomer);

// One grouped local query for the Clients Directory's KPI cards
// (Total/Credit/Direct/Uncategorized) — see customers.controller.js's
// getCustomerStats doc comment. Placed ahead of no functional conflict
// with `/:id/...` below since `stats` is a literal segment, but kept near
// the top for readability.
router.get('/stats', requireAuth, requireRole('admin', 'management'), c.getCustomerStats);

// Read-only pull from Zoho (zoho.listContacts()) into the local table.
// Never writes anything to Zoho.
router.post('/sync-from-zoho', requireAuth, requireRole('admin', 'management'), c.syncFromZoho);

// Aug 28, 2026: additive background version of the same pull — starts a
// job (202 + job_id) instead of blocking the request, so the frontend can
// show a live percentage. ?mode=quick (only contacts changed since the
// last run) or ?mode=full (everyone, guaranteed complete). Poll progress
// at GET /api/sync-jobs/:jobId. Still read-only towards Zoho.
router.post('/sync-from-zoho/start', requireAuth, requireRole('admin', 'management'), c.startSyncJob);

// Read-only per-customer detail fetch (zoho.getContact()) — fills in
// billing_address, which the bulk list-based sync above never receives from
// Zoho. Any authenticated role (not just admin/management) since a MedRep
// selecting a customer on the order form is the actual trigger for this.
router.get('/:id/address-from-zoho', requireAuth, c.getZohoAddress);

// Sets/clears a customer's local classification tag (doctor/hospital/
// distributor/pwd). Pure local write — never touches Zoho, never touches
// `type` (credit/direct). Admin/management only.
router.patch('/:id/category', requireAuth, requireRole('admin', 'management'), c.updateCustomerCategory);

// Sep 8, 2026: sets a customer's TIN, and — best-effort, never blocking —
// pushes it to Zoho's cf_tin custom field. This is the one deliberate,
// narrow exception to this app's create-only Zoho write policy; see
// customers.controller.js's updateCustomerTin for the full rationale.
// Admin/management only, same as category above.
router.patch('/:id/tin', requireAuth, requireRole('admin', 'management'), c.updateCustomerTin);

module.exports = router;
