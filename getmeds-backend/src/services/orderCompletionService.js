const db = require('../db/database');
const { setOrderStatus } = require('./orderStatusService');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');

/**
 * "An order is done when it has SHIPPED and been PAID — in whichever order
 * those two things happen."
 *
 * Sep 1, 2026. Until now nothing in this codebase ever assigned 'completed'.
 * The old auto-complete rode along with the local "Enter Tracking" button;
 * when dispatch moved into Zoho that button was retired and the completion
 * step went with it, leaving 'completed' (and 'payment_verified') declared in
 * the schema and the state machine but written by nothing. The practical
 * effect: no order could finish. A fully shipped, fully paid order sat at
 * 'tracking_shared' forever.
 *
 * It couldn't simply be bolted back onto the shipment branch either, because
 * Getmeds customers are on payment terms — payment usually lands LAST, after
 * the goods have gone out. So completion can't belong to one event; it's a
 * condition that either of two independent events can satisfy. Hence one
 * function, called from both the payment branch and the shipment branch (and
 * from the manual Sync-from-Zoho equivalents of each), rather than two
 * mirrored blocks that would drift apart the first time one was edited.
 *
 * Must stay synchronous — callers invoke it from inside better-sqlite3
 * transactions, which cannot contain an `await`.
 */

/** Has Finance's payment been recorded and verified? */
function isPaid(orderId) {
  const payment = db
    .prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'verified'")
    .get(orderId);
  return Boolean(payment);
}

/**
 * Have the goods actually gone out? A dispatch record marked 'dispatched',
 * or one carrying a tracking number, both count — Zoho can report a shipment
 * with tracking details attached or (when the Package placeholder list can't
 * expose them) without.
 */
function isShipped(orderId) {
  const dispatch = db
    .prepare('SELECT status, tracking_number FROM dispatch_records WHERE order_id = ?')
    .get(orderId);
  if (!dispatch) return false;
  return dispatch.status === 'dispatched' || Boolean(dispatch.tracking_number);
}

/**
 * Evaluate the rule and complete the order if both halves are satisfied.
 * Safe and cheap to call after ANY event — it no-ops unless something has
 * actually changed, so callers don't need to guess whether it's worth
 * calling.
 *
 * @returns {{completed: boolean, paid: boolean, shipped: boolean, status: string}}
 */
function evaluateCompletion({ orderId, currentStatus, actorId = null, actorName = 'System', trigger = null }) {
  const order = db
    .prepare(
      `SELECT o.*, u.id as medrep_user_id
       FROM orders o LEFT JOIN users u ON o.medrep_id = u.id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order) return { completed: false, paid: false, shipped: false, status: currentStatus };

  const status = currentStatus || order.status;
  if (['completed', 'cancelled'].includes(status)) {
    return { completed: status === 'completed', paid: isPaid(orderId), shipped: isShipped(orderId), status };
  }

  const paid = isPaid(orderId);
  const shipped = isShipped(orderId);
  if (!paid || !shipped) {
    return { completed: false, paid, shipped, status };
  }

  const now = new Date().toISOString();
  const result = setOrderStatus(orderId, status, 'completed', now);

  if (!result.changed) {
    // The state machine refused the hop — record why rather than silently
    // leaving a shipped-and-paid order looking unfinished with no
    // explanation for whoever goes looking later.
    logEvent({
      orderId,
      eventType: 'ORDER_COMPLETION_BLOCKED',
      oldStatus: status,
      newStatus: status,
      actorId,
      actorName,
      notes:
        `Order is both shipped and paid, but "${status}" -> "completed" is not an allowed transition, ` +
        'so it has been left as-is. This is a workflow bug — see workflow/stateMachine.js.',
      metadata: { trigger, paid, shipped }
    });
    return { completed: false, paid, shipped, status };
  }

  logEvent({
    orderId,
    eventType: 'ORDER_COMPLETED',
    oldStatus: status,
    newStatus: 'completed',
    actorId,
    actorName,
    notes: `Order complete — shipped and paid.${trigger ? ` Closed out by the ${trigger} event, which was the last of the two to arrive.` : ''}`,
    metadata: { trigger, paid, shipped, previousStatus: status }
  });

  const watchers = getUserIdsByRole('finance', 'management');
  notify({
    orderId,
    recipientIds: Array.from(new Set([order.medrep_user_id, ...watchers].filter(Boolean))),
    message: `Order ${order.getmeds_order_id} is complete — shipped and paid.`,
    eventType: 'ORDER_COMPLETED',
    orderData: { ...order, status: 'completed' }
  });

  return { completed: true, paid, shipped, status: 'completed' };
}

module.exports = { evaluateCompletion, isPaid, isShipped };
