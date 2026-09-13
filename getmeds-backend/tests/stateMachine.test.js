const stateMachine = require('../src/workflow/stateMachine');

describe('Getmeds Order State Machine', () => {
  // Valid transitions
  describe('Valid transitions', () => {
    const validCases = [
      ['draft', 'submitted'],
      ['draft', 'cancelled'],
      ['submitted', 'validating'],
      ['submitted', 'exception'],
      ['validating', 'so_pending'],
      ['validating', 'exception'],
      ['so_pending', 'so_created'],
      ['so_pending', 'exception'],

      // Sep 1, 2026 (5): the renamed spine. Both customer types follow it —
      // payment is on terms and no longer gates any of these hops.
      // Sep 1, 2026 (8): confirmation hands off to Finance for account
      // verification before anything is invoiced.
      ['so_created', 'ready_for_finance_verified'],
      ['ready_for_finance_verified', 'ready_for_draft_invoice'],
      ['ready_for_finance_verified', 'on_hold'],
      ['on_hold', 'ready_for_finance_verified'],
      // Zoho can outrun the app: an invoice raised there moves the order on
      // even though nobody pressed Verify here.
      ['ready_for_finance_verified', 'ready_for_invoice_sent'],
      ['ready_for_finance_verified', 'deleted'],
      ['ready_for_draft_invoice', 'ready_for_invoice_sent'],
      ['ready_for_invoice_sent', 'ready_for_dispatch'],
      ['ready_for_dispatch', 'picking_packing'],
      ['picking_packing', 'dispatched'],
      ['dispatched', 'tracking_shared'],
      ['tracking_shared', 'completed'],

      // Dispatch-first: the warehouse can move before Finance has invoiced,
      // and the invoice is raised afterwards.
      ['ready_for_draft_invoice', 'picking_packing'],
      ['ready_for_draft_invoice', 'dispatched'],
      ['ready_for_invoice_sent', 'picking_packing'],
      ['picking_packing', 'ready_for_invoice_sent'],
      ['tracking_shared', 'ready_for_invoice_sent'],
      ['dispatched', 'ready_for_dispatch'],

      // Completion can land from wherever the order was when the later of
      // payment/shipment arrived.
      ['ready_for_dispatch', 'completed'],
      ['picking_packing', 'completed'],
      ['dispatched', 'completed'],

      // A Sales Order can be deleted in Zoho at any point before the order
      // finishes.
      ['so_created', 'deleted'],
      ['ready_for_draft_invoice', 'deleted'],
      ['ready_for_invoice_sent', 'deleted'],
      ['ready_for_dispatch', 'deleted'],
      ['picking_packing', 'deleted'],
      ['tracking_shared', 'deleted'],

      ['ready_for_draft_invoice', 'on_hold'],
      ['ready_for_draft_invoice', 'cancelled'],
      ['ready_for_dispatch', 'on_hold'],
      ['picking_packing', 'on_hold'],
      ['dispatched', 'exception'],
      ['on_hold', 'ready_for_draft_invoice'],
      ['on_hold', 'ready_for_dispatch'],
      ['on_hold', 'cancelled'],
      ['on_hold', 'exception'],
      ['exception', 'on_hold'],
      ['exception', 'cancelled'],
    ];

    test.each(validCases)('%s → %s should be valid', (from, to) => {
      expect(stateMachine.canTransition(from, to)).toBe(true);
    });

    test.each(validCases)('%s → %s should return new status', (from, to) => {
      expect(stateMachine.transition(from, to)).toBe(to);
    });
  });

  // Invalid transitions
  describe('Invalid transitions', () => {
    const invalidCases = [
      ['completed', 'draft'],
      ['completed', 'submitted'],
      ['completed', 'cancelled'],
      ['cancelled', 'draft'],
      ['cancelled', 'submitted'],
      ['cancelled', 'ready_for_dispatch'],
      ['draft', 'ready_for_dispatch'],
      ['draft', 'completed'],
      ['dispatched', 'draft'],

      // Sep 1, 2026 (5): the retired names must be strangers to the machine,
      // or a stale reference somewhere would silently keep "working".
      ['waiting_for_payment', 'ready_for_draft_invoice'],
      ['invoice_drafted', 'ready_for_invoice_sent'],
      ['invoice_sent', 'ready_for_dispatch'],
      ['payment_verified', 'ready_for_dispatch'],
      ['so_created', 'ready_for_dispatch'],
      ['so_created', 'picking_packing'],
      // Confirmation cannot skip the verification stage.
      ['so_created', 'ready_for_draft_invoice'],

      // completed is terminal and must stay that way — reaching it means the
      // order is genuinely shipped and paid, so no webhook may reopen it.
      ['completed', 'ready_for_invoice_sent'],
      ['completed', 'ready_for_dispatch'],
      ['completed', 'tracking_shared'],
      ['completed', 'deleted'],
      ['deleted', 'cancelled'],
      ['deleted', 'so_created'],
      ['deleted', 'completed'],

      // The finance stages run forwards only — no jumping back to an earlier
      // one once the invoice has moved on.
      ['ready_for_dispatch', 'ready_for_invoice_sent'],
      ['ready_for_dispatch', 'ready_for_draft_invoice'],
      ['ready_for_dispatch', 'so_created'],
      ['ready_for_invoice_sent', 'ready_for_draft_invoice'],
    ];

    test.each(invalidCases)('%s → %s should be invalid', (from, to) => {
      expect(stateMachine.canTransition(from, to)).toBe(false);
    });

    test.each(invalidCases)('%s → %s should throw error', (from, to) => {
      expect(() => stateMachine.transition(from, to)).toThrow();
    });
  });

  // getValidTransitions
  describe('getValidTransitions', () => {
    test('completed has no valid transitions', () => {
      expect(stateMachine.getValidTransitions('completed')).toEqual([]);
    });

    test('cancelled has no valid transitions', () => {
      expect(stateMachine.getValidTransitions('cancelled')).toEqual([]);
    });

    test('draft has correct transitions', () => {
      expect(stateMachine.getValidTransitions('draft')).toEqual(expect.arrayContaining(['submitted', 'cancelled']));
    });

    test('ready_for_dispatch has correct transitions', () => {
      const valid = stateMachine.getValidTransitions('ready_for_dispatch');
      expect(valid).toContain('picking_packing');
      expect(valid).toContain('on_hold');
    });

    test('unknown status returns empty array', () => {
      expect(stateMachine.getValidTransitions('nonexistent_status')).toEqual([]);
    });

    test('invoice_sent sits between invoice_drafted and the warehouse', () => {
      const valid = stateMachine.getValidTransitions('ready_for_dispatch');
      expect(valid).toContain('picking_packing');
      expect(valid).toContain('dispatched');
      expect(valid).toContain('completed');
    });
  });

  // Sep 1, 2026: every status the schema allows must appear in the map, or a
  // status write to it will be refused at runtime by orderStatusService and
  // the order will silently stall. This catches the specific mistake of
  // adding a status to schema.sql and forgetting the state machine.
  describe('Coverage', () => {
    const SCHEMA_STATUSES = [
'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'ready_for_finance_verified', 'ready_for_draft_invoice',
    'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'
    ];

    test.each(SCHEMA_STATUSES)('%s is known to the state machine', (status) => {
      expect(stateMachine.allStatuses()).toContain(status);
    });

    test('every transition target is itself a known status', () => {
      for (const status of stateMachine.allStatuses()) {
        for (const target of stateMachine.getValidTransitions(status)) {
          expect(SCHEMA_STATUSES).toContain(target);
        }
      }
    });

    test('completed, cancelled and deleted are terminal', () => {
      expect(stateMachine.isTerminal('completed')).toBe(true);
      expect(stateMachine.isTerminal('cancelled')).toBe(true);
      expect(stateMachine.isTerminal('deleted')).toBe(true);
      expect(stateMachine.isTerminal('tracking_shared')).toBe(false);
    });

    test('deleted is reachable from every non-terminal status', () => {
      for (const status of stateMachine.allStatuses()) {
        if (stateMachine.isTerminal(status)) continue;
        expect(stateMachine.getValidTransitions(status)).toContain('deleted');
      }
    });
  });
});
