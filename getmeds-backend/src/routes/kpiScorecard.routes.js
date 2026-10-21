'use strict';

/**
 * KPI Scorecard try-out (Oct 21, 2026): NZSD and HRR from the Zoho invoice copy.
 *   GET /api/kpi-scorecard/nzsd?month=2026-10[&prefix=HOS]
 *   GET /api/kpi-scorecard/hrr?month=2026-10[&prefix=HOS]
 *   GET /api/kpi-scorecard/dso[?prefix=HOS]            today's figure only
 *   GET /api/kpi-scorecard/ist?month=2026-10[&prefix=HOS]   per person
 * Admin only, read-only. Off (404) unless GETMEDS_KPI_SCORECARD=true. See services/kpiScorecardService.js.
 */
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const scorecard = require('../services/kpiScorecardService');
const copy = require('../services/zohoInvoiceCopy');

const router = express.Router();
router.use((req, res, next) => (process.env.GETMEDS_KPI_SCORECARD === 'true'
  ? next() : res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'KPI Scorecard is switched off' } })));
router.use(requireAuth);
router.use(requireRole('admin'));

const thisMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);

function handler(kind) {
  return async (req, res, next) => {
    try {
      const month = String(req.query.month || thisMonth());
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > thisMonth()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'month must look like 2026-10 and not be in the future' } });
      }
      const prefix = req.query.prefix ? String(req.query.prefix).replace(/[^A-Za-z&]/g, '').slice(0, 10) : '';
      const st = await copy.status();
      if (kind === 'dso') {
        if (month !== thisMonth()) {
          return res.json({ success: true, data: { available: false, reason: 'DSO shows today’s figure only: Zoho keeps today’s unpaid balance, not past months’. Past months need the daily snapshot (planned).' } });
        }
        if (!st.openSyncedAt) {
          return res.json({ success: true, data: { available: false, reason: 'The unpaid invoices have not been copied from Zoho yet.' } });
        }
        const data = await scorecard.dso({ prefix });
        return res.json({ success: true, data: { available: true, prefix, as_of: st.lastRun, open_synced_at: st.openSyncedAt, covered_from: st.coveredFrom, ...data } });
      }
      const needFrom = kind === 'hrr' ? `${scorecard._test.prevMonth(month)}-01` : `${month}-01`;
      if (!st.coveredFrom || st.coveredFrom > needFrom) {
        return res.json({ success: true, data: { available: false, reason: `The invoice copy starts ${st.coveredFrom || 'nowhere yet'}; this needs ${needFrom}.` } });
      }
      const data = kind === 'hrr' ? await scorecard.hrr(month, { prefix })
        : kind === 'ist' ? await scorecard.ist(month, { prefix }) : await scorecard.nzsd(month, { prefix });
      if (data.available === false) return res.json({ success: true, data });
      return res.json({ success: true, data: { available: true, prefix, as_of: st.lastRun, covered_from: st.coveredFrom, ...data } });
    } catch (err) {
      return next(err);
    }
  };
}

router.get('/nzsd', handler('nzsd'));
router.get('/hrr', handler('hrr'));
router.get('/dso', handler('dso'));
router.get('/ist', handler('ist'));

module.exports = router;
