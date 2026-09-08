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

// Sep 5, 2026: Profile Settings — a signed-in user editing their own
// account. Split into two endpoints rather than one PATCH /me, because they
// have different validation shapes and different failure modes (a wrong
// current password is a 401, a missing display name is a 400) and the
// frontend's two separate forms (profile info / change password) map
// directly onto them.
router.patch('/profile', requireAuth, c.updateProfile);
router.patch('/password', requireAuth, c.changePassword);

module.exports = router;
