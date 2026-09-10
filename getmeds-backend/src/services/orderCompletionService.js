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

/**
 * May Zoho's own fields decide this order's fate?
 *
 * Sep 10, 2026. Only for orders IMPORTED from Zoho, and the reason is the same
 * for all three checks below.
 *
 * A historical Zoho order was invoiced, settled and shipped long before this
 * app existed. It has no local payments row and no local dispatch record, and
 * never will — so without reading Zoho's own fields the strict rule can never
 * finish it. That was 44,263 orders stuck.
 *
 * An order RAISED HERE is the opposite. The reconcile builds its payments row
 * from the invoice-paid branch and its dispatch record from the package
 * branch, so the strict rule reaches the same answer on evidence this app
 * actually holds. Letting Zoho's fields decide would add nothing except a way
 * to close an order out mid-flow, bypassing the verification steps that are
 * the point of running it here.
 *
 * It is also what Phase 1's status sync already decided (see
 * zohoOrderImportService.syncStatusesFromList): Zoho does not overwrite the
 * status of an order this app runs.
 *
 * Applied in ONE place rather than three, because three separate prefix checks
 * is three chances for one of them to be forgotten — which is exactly what
 * happened when only isDoneInZoho was gated and isPaid/isShipped still read
 * the Zoho axes straight through.
 */
function zohoMayDecide(order) {
  return String(order?.getmeds_order_id || '').startsWith('ZOHO-');
}

/**
 * Has this been paid?
 *
 * Two ways to know, and the second was missing until Sep 10, 2026.
 *
 *   1. Finance verified a payment IN THIS APP — a `payments` row.
 *   2. ZOHO says the invoice is paid — `zoho_paid_status`.
 *
 * Only the first existed, which is why 44,263 orders Zoho reports as paid and
 * closed had never completed here: there is no local payments row for an order
 * that was invoiced and settled in Zoho long before this app existed, and
 * there never will be.
 *
 * `order` is passed in by evaluateCompletion, which has already read the row.
 * It falls back to a lookup so the exported helper stays usable on its own.
 */
async function isPaid(orderId, order = null) {
  const payment = await db
    .prepare("SELECT id FROM payments WHERE order_id = ? AND status = 'verified'")
    .get(orderId);
  if (payment) return true;

  const row =
    order || (await db.prepare('SELECT getmeds_order_id, zoho_paid_status FROM orders WHERE id = ?').get(orderId));
  if (!zohoMayDecide(row)) return false;
  return String(row?.zoho_paid_status || '').toLowerCase() === 'paid';
}

/**
 * Have the goods actually gone out?
 *
 * A dispatch record marked 'dispatched', or one carrying a tracking number,
 * both count — Zoho can report a shipment with tracking details attached or
 * without.
 *
 * Sep 10, 2026: and `zoho_shipped_status` counts too, which is the case the
 * first two miss entirely. A dispatch record only exists here if the reconcile
 * found a `packages[]` entry, and in this org plenty of shipped orders have
 * none — SO-61582 is invoiced, paid and `shipped_status: fulfilled` with zero
 * packages and no tracking number, the shipment recorded on the Sales Order
 * itself as shipment_date + delivery_method: Lalamove. Requiring a package to
 * believe an order shipped meant those orders could never finish.
 */
async function isShipped(orderId, order = null) {
  const dispatch = await db
    .prepare('SELECT status, tracking_number FROM dispatch_records WHERE order_id = ?')
    .get(orderId);
  if (dispatch && (dispatch.status === 'dispatched' || Boolean(dispatch.tracking_number))) return true;

  const row =
    order || (await db.prepare('SELECT getmeds_order_id, zoho_shipped_status FROM orders WHERE id = ?').get(orderId));
  if (!zohoMayDecide(row)) return false;
  return ['shipped', 'fulfilled'].includes(String(row?.zoho_shipped_status || '').toLowerCase());
}

/**
 * Zoho's own verdict that the order is finished — for IMPORTED orders only.
 *
 * Confirmed with the business on Sep 10, 2026: `status: fulfilled` with
 * `order_status: closed` means done. When Zoho says so outright there is
 * nothing left for this app to work out — the two-part paid-and-shipped rule
 * exists to REACH that conclusion, not to second-guess it once Zoho has
 * already drawn it.
 *
 * ── WHY THIS IS GATED TO ZOHO- ORDERS ───────────────────────────────────────
 *
 * The shortcut exists for one reason: orders that were invoiced, settled and
 * shipped in Zoho long before this app existed have no local payments row and
 * no local dispatch record, and never will. There is nothing for the strict
 * rule to read, so it could never finish them — 44,263 orders' worth.
 *
 * An order RAISED HERE is the opposite case. The reconcile creates its
 * payments row from the invoice-paid branch and its dispatch record from the
 * package branch, so the strict rule reaches the same answer on evidence this
 * app actually holds. The shortcut would add nothing except a way for Zoho to
 * close out an order mid-flow, bypassing the verification steps that are the
 * whole point of running the order here.
 *
 * That is also what Phase 1's status sync decided (see
 * zohoOrderImportService.syncStatusesFromList): Zoho does not overwrite the
 * status of an order this app runs. Leaving completion ungated would have
 * contradicted it.
 */
function isDoneInZoho(order) {
  if (!zohoMayDecide(order)) return false;
  const so = String(order?.zoho_so_status || '').toLowerCase();
  const orderStatus = String(order?.zoho_order_status || '').toLowerCase();
  return so === 'fulfilled' || orderStatus === 'closed';
}

/**
 * Evaluate the rule and complete the order if both halves are satisfied.
 * Safe and cheap to call after ANY event — it no-ops unless something has
 * actually changed, so callers don't need to guess whether it's worth
 * calling.
 *
 * @returns {{completed: boolean, paid: boolean, shipped: boolean, status: string}}
 */
async function evaluateCompletion(
  { orderId, currentStatus, actorId = null, actorName = 'System', trigger = null, occurredAt = null }
) {
  const order = await db
    .prepare(
      `SELECT o.*, u.id as medrep_user_id
       FROM orders o LEFT JOIN users u ON o.medrep_id = u.id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order) return { completed: false, paid: false, shipped: false, status: currentStatus };

  const status = currentStatus || order.status;
  if (['completed', 'cancelled'].includes(status)) {
    return {
      completed: status === 'completed',
      paid: await isPaid(orderId, order),
      shipped: await isShipped(orderId, order),
      status
    };
  }

  // Sep 10, 2026: Zoho's own verdict short-circuits the rule.
  //
  // The paid-and-shipped test below is this app's way of DERIVING that an
  // order is finished. When Zoho has already closed it out, deriving it again
  // from evidence Zoho did not necessarily leave behind (a local payment row,
  // a package) is how 44,263 finished orders stayed unfinished here.
  const doneInZoho = isDoneInZoho(order);
  const paid = doneInZoho || (await isPaid(orderId, order));
  const shipped = doneInZoho || (await isShipped(orderId, order));

  if (!paid || !shipped) {
    return { completed: false, paid, shipped, status };
  }

  const now = new Date().toISOString();
  const result = await setOrderStatus(orderId, status, 'completed', now);

  if (!result.changed) {
    // The state machine refused the hop — record why rather than silently
    // leaving a shipped-and-paid order looking unfinished with no
    // explanation for whoever goes looking later.
    await logEvent({
      orderId,
      eventType: 'ORDER_COMPLETION_BLOCKED',
      oldStatus: status,
      newStatus: status,
      actorId,
      actorName,
      notes:
        `Order is both shipped and paid, but "${status}" -> "completed" is not an allowed transition, ` +
        'so it has been left as-is. This is a workflow bug — see workflow/stateMachine.js.',
      occurredAt,
      metadata: { trigger, paid, shipped }
    });
    return { completed: false, paid, shipped, status };
  }

  await logEvent({
    orderId,
    eventType: 'ORDER_COMPLETED',
    oldStatus: status,
    newStatus: 'completed',
    actorId,
    actorName,
    notes: doneInZoho
      ? 'Order complete — Zoho reports this Sales Order as fulfilled and closed.'
      : `Order complete — shipped and paid.${trigger ? ` Closed out by the ${trigger} event, which was the last of the two to arrive.` : ''}`,
    // Sep 10, 2026: dated by the caller when the facts came from Zoho — an
    // order shipped and paid in January completed in January, whatever day
    // this app worked that out. Null for a completion driven from this app,
    // where "now" is correct.
    occurredAt,
    metadata: { trigger, paid, shipped, previousStatus: status, doneInZoho }
  });

  const watchers = await getUserIdsByRole('finance', 'management');
  await notify({
    orderId,
    recipientIds: Array.from(new Set([order.medrep_user_id, ...watchers].filter(Boolean))),
    message: `Order ${order.getmeds_order_id} is complete — shipped and paid.`,
    eventType: 'ORDER_COMPLETED',
    orderData: { ...order, status: 'completed' }
  });

  return { completed: true, paid, shipped, status: 'completed' };
}

module.exports = { evaluateCompletion, isPaid, isShipped, isDoneInZoho, zohoMayDecide };
