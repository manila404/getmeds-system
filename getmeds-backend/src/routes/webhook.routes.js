const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Zoho Webhook endpoint - no JWT required (Zoho server-to-server push)
router.post('/zoho', webhookController.handleZohoWebhook);
router.post('/', webhookController.handleZohoWebhook);

module.exports = router;