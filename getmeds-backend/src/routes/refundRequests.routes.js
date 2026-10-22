const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/refundRequests.controller');

/**
 * Refund requests for orders already paid for and in Zoho (Oct 22, 2026; reworked Oct 23, 2026: no void).
 * See services/refundRequestService.js. Who may do what (the service re-checks ownership for requests and withdrawals):
 *   ask / withdraw     MedRep, Team Lead, Management, Admin
 *   decide, Refund     Management, Admin
 *   goods check        Dispatch, Admin       (returned items: good condition or damaged)
 *   Zoho steps         Finance, Admin        (record the payment / confirm the credit note; the app only reads Zoho)
 */
router.use(requireAuth);

router.post('/', requireRole('medrep', 'team_lead', 'management', 'admin'), c.create);
router.get('/order/:orderId', requireRole('medrep', 'team_lead', 'management', 'admin', 'finance', 'dispatch'), c.forOrder);
router.post('/:id/withdraw', requireRole('medrep', 'team_lead', 'management', 'admin'), c.withdraw);

router.get('/', requireRole('management', 'admin'), c.listForManagement);
router.post('/:id/approve', requireRole('management', 'admin'), c.approve);
router.post('/:id/reject', requireRole('management', 'admin'), c.reject);
router.post('/:id/refund', requireRole('management', 'admin'), c.refund);

router.get('/finance-steps', requireRole('finance', 'admin', 'management'), c.financeSteps);
router.post('/:id/payment-recorded', requireRole('finance', 'admin'), c.paymentRecorded);
router.post('/:id/credit-note-check', requireRole('finance', 'admin'), c.creditNoteChecked);

router.get('/return-checks', requireRole('dispatch', 'admin', 'management'), c.returnChecks);
router.post('/:id/goods-checked', requireRole('dispatch', 'admin'), c.goodsChecked);

module.exports = router;
