const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { signupRateLimit } = require('../middleware/signupRateLimit');
const c = require('../controllers/auth.controller');

router.post('/login', c.login);

// Sep 2, 2026: public self-service sign-up. The ONLY unauthenticated write
// endpoint in this API — see the long note on auth.controller.js's register
// for why it is safe to have one: the role is hard-coded to medrep, the email
// domain is allow-listed, and SIGNUP_ENABLED=false switches it off.
router.post('/register', signupRateLimit, c.register);

router.get('/me', requireAuth, c.me);

module.exports = router;
