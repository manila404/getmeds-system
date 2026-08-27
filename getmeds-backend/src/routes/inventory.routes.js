const express = require('express');
const router = express.Router();
const c = require('../controllers/inventory.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

// Aug 27, 2026: 'sync-push' (created/edited items in Zoho) was removed —
// this module is read-only towards Zoho now. sync-pull only reads Zoho
// (listItems) and writes to the LOCAL database; 'adjust' is local-only too.
router.get('/status', requireAuth, c.getInventoryStatus);
router.post('/sync-pull', requireAuth, requireRole('admin', 'management', 'dispatch'), c.syncPullStock);
router.post('/adjust', requireAuth, requireRole('admin', 'management', 'dispatch'), c.adjustStock);

module.exports = router;
