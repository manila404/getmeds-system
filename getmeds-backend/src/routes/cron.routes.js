'use strict';

/**
 * Scheduled-job endpoints.
 *
 * Not behind requireAuth: the caller is a scheduler, not a logged-in user.
 * Authentication is the CRON_SECRET bearer token checked inside the controller,
 * which fails closed when the secret is unset.
 *
 * GET is accepted alongside POST because Vercel Cron issues GET requests.
 */

const express = require('express');
const cron = require('../controllers/cron.controller');

const router = express.Router();

router.all('/auto-sync', cron.autoSync);
router.all('/zoho-retry', cron.zohoRetry);
router.get('/health', cron.health);

module.exports = router;
