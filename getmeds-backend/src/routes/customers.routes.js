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

// One grouped local query for the Clients Directory's KPI cards
// (Total/Credit/Direct/Uncategorized) — see customers.controller.js's
// getCustomerStats doc comment. Placed ahead of no functional conflict
// with `/:id/...` below since `stats` is a literal segment, but kept near
// the top for readability.
router.get('/stats', requireAuth, requireRole('admin', 'management'), c.getCustomerStats);

// Read-only pull from Zoho (zoho.listContacts()) into the local table.
// Never writes anything to Zoho.
router.post('/sync-from-zoho', requireAuth, requireRole('admin', 'management'), c.syncFromZoho);

// Read-only per-customer detail fetch (zoho.getContact()) — fills in
// billing_address, which the bulk list-based sync above never receives from
// Zoho. Any authenticated role (not just admin/management) since a MedRep
// selecting a customer on the order form is the actual trigger for this.
router.get('/:id/address-from-zoho', requireAuth, c.getZohoAddress);

// Sets/clears a customer's local classification tag (doctor/hospital/
// distributor/pwd). Pure local write — never touches Zoho, never touches
// `type` (credit/direct). Admin/management only.
router.patch('/:id/category', requireAuth, requireRole('admin', 'management'), c.updateCustomerCategory);

module.exports = router;
