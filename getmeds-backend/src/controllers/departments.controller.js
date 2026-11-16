const svc = require('../services/departmentsService');

// Nov 16, 2026: departments added by an admin (PAP first) and Operation's Pharmacy / Dispatcher.
// Admin-only (mounted under /api/admin). See services/departmentsService.js.

const send = (res, out) => {
  if (out && out.error) {
    return res.status(out.error.status).json({ success: false, error: { code: out.error.code, message: out.error.message } });
  }
  return res.status(out && out.created ? 201 : 200).json({ success: true, data: out });
};
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};
const num = (v) => parseInt(v, 10);

exports.list = wrap(async (req, res) => send(res, await svc.list()));
exports.create = wrap(async (req, res) => send(res, await svc.create(req.body || {}, req.user.id)));
exports.remove = wrap(async (req, res) => send(res, await svc.remove(num(req.params.id))));
exports.addMember = wrap(async (req, res) => send(res, await svc.addMember(num(req.params.id), req.body || {}, req.user.id)));
exports.removeMember = wrap(async (req, res) => send(res, await svc.removeMember(num(req.params.id), num(req.params.userId))));
exports.setOperationUnit = wrap(async (req, res) => send(res, await svc.setOperationUnit(num(req.params.id), req.body || {})));
