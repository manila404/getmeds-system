const db = require('../db/database');
const stateMachine = require('../workflow/stateMachine');
const { setOrderStatus } = require('./orderStatusService');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');

/**
 * A Finance hold ends when the order changes.
 *
 * Sep 12, 2026.
 *
 * Finance holds an order — "please provide proof of payment". The MedRep does
 * something about it. Nothing happened: the order stayed at 'on_hold' and
 * Finance was never told. The transition back was legal in the state machine
 * the whole time; nothing ever triggered it.
 *
 * GM-20260912-0002 is the case in the data. Held with "Please provide proof of
 * payment", then three PAYMENT_PROOF_UPLOADED events in a row, every one of
 * them 'on_hold -> on_hold'. The rep did what was asked, saw nothing change,
 * and did it again. Twice. A ₱62,100 order sat invisible to the person who
 * asked for the fix.
 *
 * ── Why it is narrow ──────────────────────────────────────────────────────
 *
 * 'on_hold' is reachable from eight statuses, and the warehouse and Management
 * set it too. Returning EVERY held order to Finance on any edit would drag a
 * picking-and-packing hold backwards through the pipeline. So the order only
 * goes back when the hold it is under was applied FROM
 * 'ready_for_finance_verified' — read from the trail, which is where that fact
 * already lives, rather than from a new column that would have to be kept in
 * step with it.
 *
 * ── Why it lives here ─────────────────────────────────────────────────────
 *
 * Three things count as "the order changed": a file was attached, its details
 * were edited, or its line items were. Each has its own controller, and the
 * rule is the same for all three. This app has already learned what happens
 * when one rule is inlined at several call sites — see canActOnOrder in
 * orders.controller.js, whose scattered copies is exactly how the attachment
 * permission gap survived unnoticed.
 */

const HELD_FROM = 'ready_for_finance_verified';

/**
 * Return an order to Finance if it is under a Finance hold.
 *
 * Safe to call after ANY change to any order: it answers "no" for an order
 * that is not held, or is held by someone other than Finance. Never throws —
 * a caller's own work has already succeeded by the time this runs, and failing
 * to reopen a hold must not undo it.
 *
 * @returns {Promise<boolean>} whether the order was moved.
 */
async function returnToFinanceIfHeld(order, actor, { reason } = {}) {
  try {
    if (!order || order.status !== 'on_hold') return false;

    // Which status was this hold applied from? The most recent move INTO
    // on_hold that came from somewhere else — repeated 'on_hold -> on_hold'
    // events (an upload while held) are excluded so they cannot mask it.
    const held = await db
      .prepare(
        `SELECT old_status
           FROM order_events
          WHERE order_id = ? AND new_status = 'on_hold' AND old_status <> 'on_hold'
          ORDER BY id DESC
          LIMIT 1`
      )
      .get(order.id);

    if (held?.old_status !== HELD_FROM) return false;
    if (!stateMachine.canTransition(order.status, HELD_FROM)) return false;

    const moved = await setOrderStatus(order.id, order.status, HELD_FROM);
    if (!moved.changed) return false;

    await logEvent({
      orderId: order.id,
      eventType: 'RETURNED_TO_FINANCE',
      oldStatus: 'on_hold',
      newStatus: HELD_FROM,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? 'System',
      // The status moved without anyone pressing a button that says so, which
      // is exactly when the timeline has to explain itself.
      notes: `${reason || 'Order updated'} while on hold — returned to Finance for re-verification.`,
      metadata: { trigger: reason || 'order_updated' },
    });

    await notify({
      orderId: order.id,
      recipientIds: await getUserIdsByRole('finance'),
      message: `Order ${order.getmeds_order_id} was on hold and has been updated — ready for your re-check.`,
      eventType: 'RETURNED_TO_FINANCE',
      orderData: { ...order, status: HELD_FROM },
    });

    return true;
  } catch (err) {
    // Deliberately swallowed. The attachment or edit that triggered this has
    // already been written; the worst case is the order stays held and someone
    // asks why, which is the behaviour that existed before this function did.
    console.error('[FINANCE_HOLD] could not return order to Finance:', err.message);
    return false;
  }
}

module.exports = { returnToFinanceIfHeld, HELD_FROM };
