'use strict';

const svc = require('../services/refundRequestService');

/**
 * Refund requests (Oct 22, 2026). Thin HTTP layer over services/refundRequestService.js; every rule lives there.
 * Role gates are on the routes (routes/refundRequests.routes.js).
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

exports.create = wrap(async (req) => ({
  request: await svc.create({
    user: req.user,
    orderId: Number(req.body && req.body.order_id),
    reason: req.body && req.body.reason,
    goodsStatus: req.body && req.body.goods_status,
    amount: req.body && req.body.amount
  })
}));
exports.listForManagement = wrap((req) => svc.listForManagement(String(req.query.tab || 'needs_decision')));
exports.withdraw = wrap(async (req) => ({ request: await svc.withdraw({ user: req.user, id: id(req) }) }));
exports.reject = wrap(async (req) => ({ request: await svc.reject({ user: req.user, id: id(req), note: req.body && req.body.note }) }));
exports.approve = wrap(async (req) => ({ request: await svc.approve({ user: req.user, id: id(req), note: req.body && req.body.note }) }));
exports.refund = wrap(async (req) => ({ request: await svc.queueRefund({ user: req.user, id: id(req) }) }));
exports.paymentRemoved = wrap(async (req) => ({ request: await svc.paymentRemoved({ user: req.user, id: id(req) }) }));
exports.goodsReturned = wrap(async (req) => ({ request: await svc.goodsReturned({ user: req.user, id: id(req), note: req.body && req.body.note }) }));
exports.checkVoid = wrap(async (req) => ({ request: await svc.checkVoid({ user: req.user, id: id(req) }) }));
exports.checkSalesOrder = wrap(async (req) => ({ request: await svc.checkSalesOrderClosed({ user: req.user, id: id(req) }) }));
exports.voidRequests = wrap(async () => ({ requests: await svc.listVoidRequests(), upcoming: await svc.listUpcoming() }));
exports.paymentsToRemove = wrap(async () => ({ requests: await svc.listPaymentsToRemove() }));
exports.forOrder = wrap(async (req) => ({ request: await svc.latestForOrder(Number(req.params.orderId)) }));
