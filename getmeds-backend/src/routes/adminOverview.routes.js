const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/adminOverview.controller');

// ADMIN OVERVIEW (try-out, Oct 14, 2026): read-only numbers for the Admin Overview page.
// Admin only. Delete this file with controllers/adminOverview.controller.js if the
// design is not approved.
router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/', c.getOverview);

module.exports = router;
