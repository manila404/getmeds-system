const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const zoho = require('../integrations/zoho');

/**
 * Oct 22, 2026. LOCALHOST ONLY (app.js mounts this only when ZOHO_MODE is mock).
 * The refund walkthrough needs "Dispatch voids the invoice in Zoho" and "Finance removes the payment in Zoho" to
 * happen somewhere; with the mock Zoho this is where. Sample orders only (sales order id ZSO-DEV-*).
 *
 *   POST /api/dev-zoho/invoice   { so_id, status?: 'sent' | 'paid' | 'void', balance?: number, so_status?: 'open' | 'void' }
 */
router.use(requireAuth);
router.use(requireRole('admin', 'finance', 'dispatch', 'management'));

router.post('/invoice', (req, res) => {
  if (String(process.env.ZOHO_MODE || 'mock').toLowerCase() !== 'mock') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only available against the mock Zoho.' } });
  }
  try {
    const b = req.body || {};
    const doc = zoho.getZohoAdapter().setDevInvoice(String(b.so_id || ''), { status: b.status, balance: b.balance, soStatus: b.so_status });
    res.json({ success: true, data: { invoice: doc.invoice, sales_order_status: doc.salesorder.status } });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.post('/credit-note', (req, res) => {
  if (String(process.env.ZOHO_MODE || 'mock').toLowerCase() !== 'mock') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only available against the mock Zoho.' } });
  }
  try {
    const b = req.body || {};
    const cn = zoho.getZohoAdapter().setDevCreditNote(String(b.so_id || ''), { total: b.total, status: b.status });
    res.json({ success: true, data: { credit_note: cn } });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

module.exports = router;
