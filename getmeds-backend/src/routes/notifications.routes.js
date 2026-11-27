const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/notifications.controller');

router.use(requireAuth);

router.get('/', c.getAll);
router.get('/unread-count', c.getUnreadCount);
// Nov 27, 2026: orders waiting on this person to approve (the approval sound).
router.get('/attention', c.getAttention);
router.patch('/:id/read', c.markRead);
router.patch('/mark-all-read', c.markAllRead);

module.exports = router;
