const TRANSITIONS = {
  draft: ['submitted', 'cancelled'],
  submitted: ['validating', 'exception'],
  validating: ['so_pending', 'exception'],
  so_pending: ['so_created', 'exception'],
  so_created: ['waiting_for_payment', 'ready_for_dispatch'],
  // waiting_for_payment -> invoice_drafted happens when Finance converts the
  // confirmed Sales Order to an Invoice in Zoho (webhook: invoice.created).
  // waiting_for_payment -> payment_verified/ready_for_dispatch is kept for
  // Zoho paths that register the Customer Payment directly without a
  // separate "invoice created" call ever reaching us.
  waiting_for_payment: ['invoice_drafted', 'payment_verified', 'ready_for_dispatch', 'on_hold', 'cancelled'],
  // invoice_drafted -> ready_for_dispatch happens when Finance records the
  // Customer Payment against that Invoice in Zoho (webhook: invoice paid /
  // payment created).
  invoice_drafted: ['payment_verified', 'ready_for_dispatch', 'on_hold', 'cancelled'],
  payment_verified: ['ready_for_dispatch'],
  ready_for_dispatch: ['picking_packing', 'on_hold'],
  picking_packing: ['dispatched', 'on_hold'],
  dispatched: ['tracking_shared', 'exception'],
  tracking_shared: ['completed'],
  on_hold: ['ready_for_dispatch', 'cancelled', 'exception'],
  exception: ['on_hold', 'cancelled'],
  completed: [],
  cancelled: []
};

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
}

module.exports = new StateMachine();
