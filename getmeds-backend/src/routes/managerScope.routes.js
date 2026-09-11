const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/managerScope.controller');

// Sep 11, 2026 (Phase D): which divisions each manager covers.
//
// The role gate here is the coarse one — admin and management. The finer check
// is inside the controller, because "management" is not the answer: a
// DIVISION-SCOPED manager must not reach these endpoints at all, or they can
// widen their own remit and the restriction stops meaning anything. Only an
// admin or a full-scope manager passes canManageScopes().
router.use(requireAuth, requireRole('admin', 'management'));

router.get('/', c.list);
router.put('/:userId', c.set);

module.exports = router;
