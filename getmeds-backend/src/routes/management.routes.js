const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/management.controller');

router.use(requireAuth);
// Sep 21, 2026: 'team_lead' added — read-only, same two GET endpoints,
// scoped to their assigned MedReps instead of a division (see
// management.controller.js / services/teamScopeService.js). Nothing else in
// this router needs a change: there is nothing else in this router.
router.use(requireRole('management', 'admin', 'team_lead'));

router.get('/summary', c.getSummary);
router.get('/orders', c.getAllOrders);

module.exports = router;
