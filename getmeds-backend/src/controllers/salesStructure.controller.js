'use strict';

/**
 * Sales team structure: admin only (the router applies isAdmin).
 * See services/salesStructureService.js for what this is and is not.
 *
 *   GET    /api/admin/team-structure                      the tree, matched accounts, and the issues
 *   POST   /api/admin/team-structure/import               load the bundled sheet (inserts what is missing)
 *   GET    /api/admin/team-structure/team-lead-plan       PREVIEW ONLY: which accounts' Team Lead would change
 *   POST   /api/admin/team-structure/team-lead-plan/apply { account_ids: [...] }  changes exactly those
 *   POST   /api/admin/team-structure/channels             PATCH /channels/:id
 *   POST   /api/admin/team-structure/managers             PATCH /managers/:id      DELETE /managers/:id
 *   POST   /api/admin/team-structure/territories          PATCH /territories/:id   DELETE /territories/:id
 */

const svc = require('../services/salesStructureService');

const MAX_APPLY = 200;

const send = (res, out, okStatus = 200) => {
  if (out && out.error) {
    return res.status(out.error.status).json({ success: false, error: { code: out.error.code, message: out.error.message } });
  }
  return res.status(out && out.created ? 201 : okStatus).json({ success: true, data: out });
};

const idOf = (req) => parseInt(req.params.id, 10);
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};

exports.get = wrap(async (req, res) => {
  res.json({ success: true, data: await svc.getStructure() });
});

exports.importSheet = wrap(async (req, res) => {
  const overwrite = req.body && req.body.overwrite === true;
  res.json({ success: true, data: await svc.importSeed({ overwrite, actorId: req.user.id }) });
});

exports.teamLeadPlan = wrap(async (req, res) => {
  res.json({ success: true, data: await svc.planTeamLeads() });
});

exports.applyTeamLeads = wrap(async (req, res) => {
  const ids = req.body && req.body.account_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_APPLY || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `account_ids must list the accounts to change (1 to ${MAX_APPLY} account ids). There is no "apply all": review the preview and name each account.`,
      },
    });
  }
  res.json({ success: true, data: await svc.applyTeamLeads([...new Set(ids)], req.user.id) });
});

const access = require('../services/managerAccessSyncService');

// Manager Access from the structure: a PREVIEW, and an explicit apply. See
// services/managerAccessSyncService.js for the three safeguards.
exports.managerAccessPlan = wrap(async (req, res) => {
  res.json({ success: true, data: await access.plan() });
});

exports.applyManagerAccess = wrap(async (req, res) => {
  const ids = req.body && req.body.user_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_APPLY || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: `user_ids must list the managers to change (1 to ${MAX_APPLY}). There is no "apply all".` },
    });
  }
  const out = await access.apply([...new Set(ids)], { confirmRestrict: req.body.confirm_restrict === true, actorId: req.user.id });
  if (out.error) return res.status(out.error.status).json({ success: false, error: { code: out.error.code, message: out.error.message } });
  res.json({ success: true, data: out });
});

exports.createChannel =wrap(async (req, res) => send(res, await svc.saveChannel(null, req.body || {}, req.user.id)));
exports.updateChannel = wrap(async (req, res) => send(res, await svc.saveChannel(idOf(req), req.body || {}, req.user.id)));
exports.createManager = wrap(async (req, res) => send(res, await svc.saveManager(null, req.body || {}, req.user.id)));
exports.updateManager = wrap(async (req, res) => send(res, await svc.saveManager(idOf(req), req.body || {}, req.user.id)));
exports.removeManager = wrap(async (req, res) => send(res, await svc.deleteManager(idOf(req))));
exports.createApprover = wrap(async (req, res) => send(res, await svc.addApprover(req.body || {}, req.user.id)));
exports.removeApprover = wrap(async (req, res) => send(res, await svc.deleteApprover(idOf(req))));
exports.createTerritory =wrap(async (req, res) => send(res, await svc.saveTerritory(null, req.body || {}, req.user.id)));
exports.updateTerritory = wrap(async (req, res) => send(res, await svc.saveTerritory(idOf(req), req.body || {}, req.user.id)));
exports.removeTerritory = wrap(async (req, res) => send(res, await svc.deleteTerritory(idOf(req))));
