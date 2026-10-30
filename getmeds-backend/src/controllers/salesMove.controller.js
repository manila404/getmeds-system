'use strict';

/**
 * Move / change role for someone in the Sales department (Admin). Oct 30, 2026.
 * See services/salesMoveService.js.
 *
 *   GET  /api/admin/users/:id/sales-move          what they hold now, and the choices
 *   POST /api/admin/users/:id/sales-move/preview  the switches a choice makes; nothing saved
 *   POST /api/admin/users/:id/sales-move/apply    makes them
 */

const svc = require('../services/salesMoveService');

const idOf = (req) => parseInt(req.params.id, 10);
const handle = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    if (err instanceof svc.MoveError) {
      return res.status(err.status).json({ success: false, error: { code: 'SALES_MOVE', message: err.message } });
    }
    next(err);
  }
};

exports.describe = handle((req) => svc.describe(idOf(req)));
exports.preview = handle(async (req) => {
  const { switches, errors } = await svc.plan(idOf(req), req.body || {});
  return { switches, errors };
});
exports.apply = handle((req) => svc.apply(idOf(req), req.body || {}, { id: req.user.id, name: req.user.name || req.user.email }));
