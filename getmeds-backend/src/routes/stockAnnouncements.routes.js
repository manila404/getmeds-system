const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/stockAnnouncements.controller');

// Sep 15, 2026: Dispatch's stock announcements. Everyone signed in can read
// the open ones (the MedRep and Management dashboards, the order form); only
// Dispatch, Management and admin post or resolve them.
router.use(requireAuth);
router.get('/', c.list);
router.post('/', requireRole('dispatch', 'management', 'admin'), c.create);
router.post('/:id/resolve', requireRole('dispatch', 'management', 'admin'), c.resolve);

module.exports = router;
