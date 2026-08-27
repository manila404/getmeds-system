const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/orders.controller');

// All orders routes require authentication
router.use(requireAuth);

// Meta endpoints (customers + products for dropdowns)
router.get('/meta/customers', c.getCustomers);
router.get('/meta/products', c.getProducts);

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
router.patch('/:id/exception', requireRole('management', 'admin'), c.setException);

module.exports = router;
