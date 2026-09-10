const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/salespersonMapping.controller');

// Sep 10, 2026: who owns the Sales Orders imported from Zoho.
//
// Admin AND management. The people who know which rep is which are the sales
// leads; routing every one of 171 decisions through an admin is how the review
// never happens. Nothing below this line is reachable by a MedRep — they are
// the subject of these decisions, not a party to them.
router.use(requireAuth, requireRole('admin', 'management'));

router.get('/', c.list);
router.patch('/', c.set);

// Dry run unless ?confirm=true — see the controller.
router.post('/apply', c.apply);

module.exports = router;
