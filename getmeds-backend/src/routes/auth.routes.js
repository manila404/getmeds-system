const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/auth.controller');

router.post('/login', c.login);

// Sep 11, 2026: POST /register (public self-service sign-up) removed. Every
// account is now created by an admin through POST /api/admin/users and handed
// to the person, so /login is the only unauthenticated endpoint here.

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
