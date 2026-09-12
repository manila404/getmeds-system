/**
 * The allowed order-status transitions.
 *
 * Sep 1, 2026: this map is ENFORCED, not advisory. Every status write driven
 * by Zoho (webhook.controller.js and services/zohoReconcileService.js) goes
 * through services/orderStatusService.js, which asks this map first and
 * refuses anything it doesn't allow. If you add a new hop to a controller,
 * add it here too or it will be refused at runtime.
 *
 * ── Sep 1, 2026 (5): the middle of the pipeline was renamed ────────────────
 *
 * The finance stages now say what the order is WAITING FOR rather than what
 * last happened to it, so a queue reads as a to-do list:
 *
 *   (new)                ->  ready_for_finance_verified (Finance: check the account)
 *   waiting_for_payment  ->  ready_for_draft_invoice   (Finance: raise the invoice)
 *   invoice_drafted      ->  ready_for_invoice_sent    (Finance: issue it to the customer)
 *   invoice_sent         ->  ready_for_dispatch        (Warehouse: pack and ship)
 *
 * Note the third line carefully: `ready_for_dispatch` still exists but MEANS
 * SOMETHING DIFFERENT. It used to mean "the Sales Order is confirmed, go
 * pack"; it now means "the invoice has been issued, go pack". Existing rows
 * were remapped accordingly by src/db/migrate.js — an order sitting at the
 * old ready_for_dispatch had not been invoiced at all, so it moves back to
 * ready_for_draft_invoice (or to ready_for_invoice_sent if an invoice id was
 * already on file).
 *
 * `payment_verified` is gone. Nothing ever assigned it, and payment no longer
 * moves the pipeline at all: Getmeds customers are on terms, so the money can
 * arrive at any point and its only effect is on completion (shipped AND paid —
 * see services/orderCompletionService.js). Both customer types now follow one
 * chain; `waiting_for_payment` as a distinct stop for direct customers is
 * gone with it.
 *
 * The map stays permissive about ORDERING in the middle, because Zoho — not
 * this app — decides what happens when, and Getmeds runs both:
 *   invoice-first : confirm -> draft invoice -> send -> pack -> ship
 *   dispatch-first: confirm -> pack -> ship -> draft invoice -> send
 * What it is STRICT about is the two ends: nothing skips from draft into a
 * fulfilment state, and completed/cancelled/deleted are terminal.
 *
 * 'deleted' is reachable from every non-terminal state, because a Sales Order
 * can be removed in Zoho at any point. It is NOT reachable from 'completed' —
 * deleting the Zoho record long after an order shipped and was paid does not
 * un-finish it — nor from 'cancelled', already closed out.
 */
const TRANSITIONS = {
  // Sep 7, 2026: a new gate ahead of 'submitted', only ever entered when a
  // MedRep submits their own order (see orders.controller.js's submit()).
  // The order sits here — nothing has reached Zoho yet — until Management
  // approves it (-> 'submitted', which then runs the SAME Zoho-sync pipeline
  // a Management/admin submission always ran) or rejects it (-> 'on_hold',
  // with a required reason, same pattern as Finance's verifyAccount). A
  // Management/admin submission is untouched: it still goes straight from
  // 'draft' through the Zoho pipeline in one action and never visits this
  // status.
  // Sep 12, 2026: 'ready_for_finance_verified' and 'ready_for_draft_invoice'
  // added. A credit order raised by someone who needs no approval is written
  // straight to Finance now that Finance's verification is what confirms the
  // Sales Order in Zoho (see finance.controller.js's verifyAccount). Both
  // create paths set that status with a direct UPDATE, so nothing was
  // refusing it at runtime -- but a map that does not list a transition the
  // system performs is a map nobody can trust.
  draft: ['submitted', 'pending_management_approval', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'cancelled', 'deleted'],
  // Sep 7, 2026 (2): 'draft' added — Management can send a pending order
  // back to the MedRep to fix instead of approving or rejecting it outright
  // (see orders.controller.js's sendBack). The order keeps its
  // getmeds_order_id and goes right back through this same gate once the
  // MedRep edits and resubmits it.
  // Sep 12, 2026: approving a credit order now lands it on Finance directly
  // rather than at 'so_created' waiting for a manual Zoho confirmation.
  pending_management_approval: ['submitted', 'draft', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'on_hold', 'cancelled', 'deleted'],
  submitted: ['validating', 'exception', 'deleted'],
  validating: ['so_pending', 'exception', 'deleted'],
  so_pending: ['so_created', 'exception', 'deleted'],

  // Where BOTH customer types wait after the app has created a Draft Sales
  // Order in Zoho. Nothing moves until Zoho reports it confirmed.
  so_created: ['ready_for_finance_verified', 'on_hold', 'cancelled', 'deleted'],

  // Sep 1, 2026 (8): the one stage Zoho has no record of. Finance checks the
  // customer's account in Zoho Books — overdue balance, account problems —
  // and approves or rejects. That is a human judgement, so it is recorded by
  // an action in this app (see finance.controller.js), not by a webhook.
  //
  // The dispatch-side hops are here for a reason: this app cannot stop anyone
  // raising an invoice directly in Zoho. If that happens the order arrives at
  // invoice.created still sitting here, and refusing the transition would
  // strand it. So an invoice appearing IS treated as sufficient evidence
  // Finance approved it — the trail says so explicitly when it happens.
  ready_for_finance_verified: [
    'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'on_hold', 'cancelled', 'deleted'
  ],

  // Finance's two stages. The dispatch hops are here because in the
  // dispatch-first ordering the warehouse can start before either happens.
  ready_for_draft_invoice: [
    'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing', 'dispatched',
    'on_hold', 'cancelled', 'deleted'
  ],
  ready_for_invoice_sent: [
    'ready_for_dispatch', 'picking_packing', 'dispatched',
    'on_hold', 'cancelled', 'deleted'
  ],

  // Invoice issued — the warehouse's queue.
  ready_for_dispatch: ['picking_packing', 'dispatched', 'completed', 'on_hold', 'cancelled', 'deleted'],

  // The dispatch-side states keep edges back to the finance stages, for the
  // dispatch-first ordering where the invoice is raised after the goods go
  // out. The branch guards in the controllers stop these being downgrades.
  picking_packing: ['dispatched', 'ready_for_invoice_sent', 'ready_for_dispatch', 'completed', 'on_hold', 'cancelled', 'deleted'],
  dispatched: ['tracking_shared', 'completed', 'ready_for_invoice_sent', 'ready_for_dispatch', 'exception', 'deleted'],
  tracking_shared: ['completed', 'ready_for_invoice_sent', 'ready_for_dispatch', 'deleted'],

  on_hold: [
    'ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'cancelled', 'exception', 'deleted'
  ],
  exception: ['on_hold', 'cancelled', 'deleted'],
  completed: [],
  cancelled: [],
  deleted: []
};

// Statuses that mean the order is finished one way or the other — nothing
// further should move them.
const TERMINAL = ['completed', 'cancelled', 'deleted'];

class StateMachine {
  getValidTransitions(status) {
    return TRANSITIONS[status] || [];
  }

  canTransition(fromStatus, toStatus) {
    const valid = this.getValidTransitions(fromStatus);
    return valid.includes(toStatus);
  }

  transition(fromStatus, toStatus) {
    if (!this.canTransition(fromStatus, toStatus)) {
      throw new Error(`Invalid transition from ${fromStatus} to ${toStatus}`);
    }
    return toStatus;
  }

  isTerminal(status) {
    return TERMINAL.includes(status);
  }

  /** Every status this machine knows about — used by tests and tooling. */
  allStatuses() {
    return Object.keys(TRANSITIONS);
  }
}

module.exports = new StateMachine();
