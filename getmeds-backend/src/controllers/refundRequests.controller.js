'use strict';

const svc = require('../services/refundRequestService');

/**
 * Refund requests (Oct 22, 2026; reworked Oct 23, 2026: no void). Thin HTTP layer over services/refundRequestService.js;
 * every rule lives there. Role gates are on the routes (routes/refundRequests.routes.js).
 */
const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof svc.RefundError) {
      return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    next(err);
  }
};

const id = (req) => Number(req.params.id);
const body = (req) => req.body || {};

exports.create = wrap(async (req) => ({
  request: await svc.create({ user: req.user, orderId: Number(body(req).order_id), reason: body(req).reason, goodsStatus: body(req).goods_status, amount: body(req).amount })
}));
exports.listForManagement = wrap((req) => svc.listForManagement(String(req.query.tab || 'needs_decision')));
exports.withdraw = wrap(async (req) => ({ request: await svc.withdraw({ user: req.user, id: id(req) }) }));
exports.reject = wrap(async (req) => ({ request: await svc.reject({ user: req.user, id: id(req), note: body(req).note }) }));
exports.approve = wrap(async (req) => ({ request: await svc.approve({ user: req.user, id: id(req), note: body(req).note }) }));
exports.refund = wrap(async (req) => ({ request: await svc.queueRefund({ user: req.user, id: id(req) }) }));
exports.goodsChecked = wrap(async (req) => ({ request: await svc.goodsChecked({ user: req.user, id: id(req), condition: body(req).condition, note: body(req).note }) }));
exports.paymentRecorded = wrap(async (req) => ({ request: await svc.paymentRecorded({ user: req.user, id: id(req) }) }));
exports.creditNoteChecked = wrap(async (req) => ({ request: await svc.creditNoteChecked({ user: req.user, id: id(req), number: body(req).number }) }));
exports.returnChecks = wrap(async () => ({ requests: await svc.listReturnChecks(), upcoming: await svc.listUpcoming() }));
exports.financeSteps = wrap(async () => ({ requests: await svc.listFinanceSteps() }));
exports.forOrder = wrap(async (req) => ({ request: await svc.latestForOrder(Number(req.params.orderId)) }));
