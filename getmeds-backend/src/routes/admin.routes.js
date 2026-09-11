const express = require('express');
const router = express.Router();
const { requireAuth, isAdmin } = require('../middleware/auth');
const adminController = require('../controllers/admin.controller');

// Secure all admin routes: require valid authentication and Admin role
router.use(requireAuth);
router.use(isAdmin);

// Route to get all users: GET /api/admin/users
// Sep 11, 2026: the sign-up approval queue, as a number the sidebar can show.
//
// Declared ABOVE any '/users/:id' route — Express matches in declaration
// order, so '/users/pending' below one of those would be read as "the user
// whose id is pending".
router.get('/users/pending', adminController.getPendingUsers);

router.get('/users', adminController.getAllUsers);

// Sep 11, 2026: the Zoho Salesperson list an admin assigns from.
//
// A picker, not a text box, and deliberately so. A Salesperson name Zoho does
// not recognise is not rejected on the first order — LiveZohoAdapter creates
// it — so a typo here becomes a permanent junk Salesperson in the company's
// org. Read-only towards Zoho.
router.get('/salespersons', adminController.getSalespersons);

// Route to create a new user: POST /api/admin/users
router.post('/users', adminController.create);

// Route to update user: PATCH /api/admin/users/:id
router.patch('/users/:id', adminController.update);

// Route to deactivate a user (Soft Delete): PATCH /api/admin/users/:id/deactivate
router.patch('/users/:id/deactivate', adminController.deactivateUser);

// Sep 9, 2026: the sign-up approval queue.
//
// Sep 11, 2026: self-service sign-up is gone, so nothing creates a 'pending'
// account any more. These stay for the ones already waiting when it was
// removed — without them those rows could never be approved or turned away.
// Admin-only, like everything else on this router — see the
// router.use(isAdmin) above.
router.post('/users/:id/approve', adminController.approveUser);
router.post('/users/:id/reject', adminController.rejectUser);

// Zoho sync retry outbox: view queued/failed syncs, or trigger an immediate retry pass
router.get('/zoho/queue', adminController.getZohoQueue);
router.post('/zoho/queue/retry', adminController.retryZohoQueue);

module.exports = router;

