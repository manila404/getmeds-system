const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/stockAnnouncements.controller');

// Sep 15, 2026: Dispatch's stock announcements. Everyone signed in can read
// the open ones (the MedRep and Management dashboards, the order form); only
// Dispatch, Management and admin post or resolve them.
router.use(requireAuth);
router.get('/', c.list);
// Sep 28, 2026: anyone can mark their own as seen — it only ever touches the
// caller's own account (req.user.id), never anyone else's.
router.post('/seen', c.markSeen);
// Nov 14, 2026: Finance too, for Buy 1 Take 1 promos only (checked in the controller).
router.post('/', requireRole('dispatch', 'finance', 'management', 'admin'), c.create);
router.post('/:id/resolve', requireRole('dispatch', 'finance', 'management', 'admin'), c.resolve);

module.exports = router;
