const db = require('../db/database');
const stateMachine = require('../workflow/stateMachine');

/**
 * The single place an order's status is written.
 *
 * Sep 1, 2026. Before this existed, every Zoho-driven branch in
 * webhook.controller.js and orders.controller.js ran its own
 * `UPDATE orders SET status = ?` and nothing ever consulted
 * workflow/stateMachine.js — so the transition map and its 79 passing tests
 * described a pipeline that wasn't the one running. Transitions the map
 * forbids were happening for real (tracking_shared -> invoice_drafted, for
 * one), and the only guard against a nonsense hop was whatever ad-hoc
 * `['a','b','c'].includes(order.status)` list that particular branch
 * happened to carry.
 *
 * This routes every one of those writes through the map.
 *
 * Deliberately NON-THROWING. A webhook is an inbound message from a system
 * we don't control: if Zoho sends something that would imply an impossible
 * hop, the right answer is to keep the order where it is, leave a warning,
 * and still return 200 — not to 500 at Zoho, which would make it retry the
 * same impossible thing on a schedule. Callers get `refused: true` back and
 * can log it in the audit trail.
 */
function setOrderStatus(orderId, fromStatus, toStatus, now = new Date().toISOString()) {
  if (!toStatus || fromStatus === toStatus) {
    return { changed: false, status: fromStatus, refused: false };
  }

  if (stateMachine.isTerminal(fromStatus)) {
    console.warn(
      `[STATE] Order ${orderId} is already "${fromStatus}" (terminal) — refusing to move it to "${toStatus}".`
    );
    return { changed: false, status: fromStatus, refused: true };
  }

  if (!stateMachine.canTransition(fromStatus, toStatus)) {
    console.warn(
      `[STATE] Refusing "${fromStatus}" -> "${toStatus}" for order ${orderId}: not an allowed transition ` +
        `(see workflow/stateMachine.js). Order left at "${fromStatus}".`
    );
    return { changed: false, status: fromStatus, refused: true };
  }

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, now, orderId);
  return { changed: true, status: toStatus, refused: false };
}

/**
 * Pick the first candidate status that is actually reachable from where the
 * order is now. Lets a caller say "advance to picking_packing if that makes
 * sense from here, otherwise leave it alone" without repeating the
 * `.includes(order.status)` guard lists that used to be copy-pasted between
 * the webhook handler and the manual sync — and which drifted apart from
 * each other more than once.
 */
function advanceTo(orderId, fromStatus, toStatus, now) {
  if (!stateMachine.canTransition(fromStatus, toStatus)) {
    return { changed: false, status: fromStatus, refused: false, skipped: true };
  }
  return setOrderStatus(orderId, fromStatus, toStatus, now);
}

module.exports = { setOrderStatus, advanceTo };
