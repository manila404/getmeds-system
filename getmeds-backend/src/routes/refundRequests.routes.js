const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/refundRequests.controller');

/**
 * Refund requests for orders already paid for and in Zoho (Oct 22, 2026). See services/refundRequestService.js.
 * Who may do what (the service re-checks ownership for requests and withdrawals):
 *   ask / withdraw     MedRep, Team Lead, Management, Admin
 *   decide, Refund     Management, Admin
 *   remove payment     Finance, Admin       (the app only reads Zoho to check)
 *   goods, void check  Dispatch, Admin
 */
router.use(requireAuth);

router.post('/', requireRole('medrep', 'team_lead', 'management', 'admin'), c.create);
router.get('/order/:orderId', requireRole('medrep', 'team_lead', 'management', 'admin', 'finance', 'dispatch'), c.forOrder);
router.post('/:id/withdraw', requireRole('medrep', 'team_lead', 'management', 'admin'), c.withdraw);

router.get('/', requireRole('management', 'admin'), c.listForManagement);
router.post('/:id/approve', requireRole('management', 'admin'), c.approve);
router.post('/:id/reject', requireRole('management', 'admin'), c.reject);
router.post('/:id/refund', requireRole('management', 'admin'), c.refund);

router.get('/payments-to-remove', requireRole('finance', 'admin', 'management'), c.paymentsToRemove);
router.post('/:id/payment-removed', requireRole('finance', 'admin'), c.paymentRemoved);

router.get('/void-requests', requireRole('dispatch', 'admin', 'management'), c.voidRequests);
router.post('/:id/goods-returned', requireRole('dispatch', 'admin'), c.goodsReturned);
router.post('/:id/check-void', requireRole('dispatch', 'admin'), c.checkVoid);
router.post('/:id/check-so', requireRole('dispatch', 'admin'), c.checkSalesOrder);

module.exports = router;
