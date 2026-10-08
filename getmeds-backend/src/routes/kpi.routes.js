const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { isKpiPageEnabled, canViewAllKpis, canViewOwnKpis, canSetAnyTarget } = require('../services/kpiPermissions');
const c = require('../controllers/kpi.controller');

/**
 * Oct 5, 2026: the KPI page (Aaron sheet 13.1.2) — see controllers/kpi.controller.js.
 *
 * Off by default: while GETMEDS_KPI_PAGE is not "true" every route here is a plain 404, as
 * if it did not exist. Who may do what is decided only in services/kpiPermissions.js
 * (Admin only for now), so letting Management or Team Leads in later is a change there.
 */
router.use((req, res, next) => {
  if (isKpiPageEnabled()) return next();
  return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` } });
});
router.use(requireAuth);

const allow = (check) => (req, res, next) =>
  check(req.user) ? next() : res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have access to KPIs' } });

router.get('/status', allow((u) => canViewAllKpis(u) || canViewOwnKpis(u)), c.getStatus);
// Oct 6, 2026: My Own KPI and My Team KPI for every salesperson and team lead (sheet 12.13).
router.get('/me', allow(canViewOwnKpis), c.getMyKpis);
router.get('/', allow(canViewAllKpis), c.getKpis);
router.get('/targets', allow(canSetAnyTarget), c.getTargets);
router.put('/targets/:month', allow(canSetAnyTarget), c.putTargets);
router.post('/targets/:month/copy', allow(canSetAnyTarget), c.copyTargets);
// Oct 8, 2026: pre-fill from the sales sheet's per-territory targets (preview first, then apply)
router.post('/targets/:month/from-structure', allow(canSetAnyTarget), c.targetsFromStructure);
router.get('/target-changes', allow(canSetAnyTarget), c.getTargetChanges);

module.exports = router;
