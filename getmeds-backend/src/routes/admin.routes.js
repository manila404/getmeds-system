const express = require('express');
const router = express.Router();
const { requireAuth, isAdmin } = require('../middleware/auth');
const adminController = require('../controllers/admin.controller');

// Secure all admin routes: require valid authentication and Admin role
router.use(requireAuth);
router.use(isAdmin);

// Route to get all users: GET /api/admin/users

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

// Sep 24, 2026: permanent removal, from the User Details modal. Refused when the
// account has any history — see the handler's own header.
router.delete('/users/:id', adminController.deleteUser);

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

// Sep 26, 2026: the sales team structure (Head > Channel > Manager > Territory), and
// the preview / explicit apply of Team Leads that follows from it. Descriptive:
// nothing in the order flow reads it. See services/salesStructureService.js.
const structure = require('../controllers/salesStructure.controller');
router.get('/team-structure', structure.get);
router.post('/team-structure/import', structure.importSheet);
router.get('/team-structure/team-lead-plan', structure.teamLeadPlan);
router.post('/team-structure/team-lead-plan/apply', structure.applyTeamLeads);
router.get('/team-structure/manager-access-plan', structure.managerAccessPlan);
router.post('/team-structure/manager-access-plan/apply', structure.applyManagerAccess);
router.post('/team-structure/channels', structure.createChannel);
router.patch('/team-structure/channels/:id', structure.updateChannel);
router.post('/team-structure/managers', structure.createManager);
router.patch('/team-structure/managers/:id', structure.updateManager);
router.delete('/team-structure/managers/:id', structure.removeManager);
router.post('/team-structure/approvers', structure.createApprover);
router.delete('/team-structure/approvers/:id', structure.removeApprover);
router.post('/team-structure/territories', structure.createTerritory);
router.patch('/team-structure/territories/:id', structure.updateTerritory);
router.delete('/team-structure/territories/:id', structure.removeTerritory);

// Zoho sync retry outbox: view queued/failed syncs, or trigger an immediate retry pass
router.get('/zoho/queue', adminController.getZohoQueue);
router.post('/zoho/queue/retry', adminController.retryZohoQueue);

module.exports = router;

