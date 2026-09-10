/**
 * Sep 10, 2026 (Phase 3) — what "complete" means.
 *
 * The rule was "shipped AND paid", with shipped proven by a local dispatch
 * record and paid by a local verified payment. Both are things this app
 * creates. An order invoiced, settled and shipped in Zoho before this app
 * existed has neither and never will — which is why 44,263 orders Zoho reports
 * as fulfilled and closed had never completed here, and why the Completed KPI
 * read zero against 60,817 imported orders.
 *
 * Confirmed with the business: `status: fulfilled` with `order_status: closed`
 * genuinely means done.
 */
const db = require('../src/db/database');
const { evaluateCompletion, isPaid, isShipped, isDoneInZoho } = require('../src/services/orderCompletionService');

const orderIds = [];
let customer, rep;

async function seed({ ref, status = 'ready_for_dispatch', zoho = {} }) {
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, zoho_so_id,
                           zoho_so_status, zoho_order_status, zoho_invoiced_status,
                           zoho_paid_status, zoho_shipped_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 100, 'See Zoho', 'synced', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ref, customer.id, rep.id, status, `SOID-${ref}`,
      zoho.so ?? null, zoho.order ?? null, zoho.invoiced ?? null,
      zoho.paid ?? null, zoho.shipped ?? null, now, now
    );
  orderIds.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

describe('Completing an order', () => {
  beforeAll(async () => {
    customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
    rep = await db.prepare("SELECT * FROM users WHERE LOWER(role)='medrep' LIMIT 1").get();
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  describe('Zoho\'s own verdict', () => {
    test('fulfilled and closed is done, with no local payment or dispatch record', async () => {
      // THE case that was broken. No payments row, no dispatch_records row, no
      // package — exactly how a historical Zoho order arrives here.
      const id = await seed({
        ref: 'ZOHO-COMPLETE-1',
        zoho: { so: 'fulfilled', order: 'closed', invoiced: 'invoiced', paid: 'paid', shipped: 'fulfilled' }
      });

      const res = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });

      expect(res.completed).toBe(true);
      expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status).toBe('completed');
    });

    test('the trail says it was Zoho that closed it, not our own derivation', async () => {
      const id = orderIds[orderIds.length - 1];
      const ev = await db
        .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ORDER_COMPLETED'")
        .get(id);
      expect(ev.notes).toMatch(/fulfilled and closed/i);
      expect(JSON.parse(ev.metadata).doneInZoho).toBe(true);
    });

    test('order_status closed alone is enough', async () => {
      const id = await seed({ ref: 'ZOHO-COMPLETE-2', zoho: { so: 'shipped', order: 'closed' } });
      const res = await evaluateCompletion({ orderId: id, currentStatus: 'dispatched' });
      expect(res.completed).toBe(true);
    });
  });

  describe('the paid-and-shipped rule still applies when Zoho has not closed it', () => {
    test('paid in Zoho but not shipped is not complete', async () => {
      const id = await seed({
        ref: 'ZOHO-COMPLETE-3',
        zoho: { so: 'invoiced', order: 'open', invoiced: 'invoiced', paid: 'paid', shipped: 'not_shipped' }
      });
      const res = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });

      expect(res.paid).toBe(true);
      expect(res.shipped).toBe(false);
      expect(res.completed).toBe(false);
    });

    test('shipped in Zoho but unpaid is not complete', async () => {
      const id = await seed({
        ref: 'ZOHO-COMPLETE-4',
        zoho: { so: 'shipped', order: 'open', invoiced: 'invoiced', paid: 'unpaid', shipped: 'shipped' }
      });
      const res = await evaluateCompletion({ orderId: id, currentStatus: 'dispatched' });

      expect(res.shipped).toBe(true);
      expect(res.paid).toBe(false);
      expect(res.completed).toBe(false);
    });

    test('both, from Zoho alone, completes', async () => {
      const id = await seed({
        ref: 'ZOHO-COMPLETE-5',
        zoho: { so: 'shipped', order: 'open', invoiced: 'invoiced', paid: 'paid', shipped: 'shipped' }
      });
      const res = await evaluateCompletion({ orderId: id, currentStatus: 'dispatched' });
      expect(res.completed).toBe(true);
    });
  });

  describe('orders raised in this app are unaffected', () => {
    test('a local order with no Zoho status is judged the old way', async () => {
      // Nothing about this change may weaken the rule for orders this app
      // actually runs: they have no Zoho axes at all, so the local payment and
      // dispatch checks are the only evidence, exactly as before.
      const id = await seed({ ref: 'GM-COMPLETE-6', status: 'ready_for_dispatch' });

      expect(await isPaid(id)).toBe(false);
      expect(await isShipped(id)).toBe(false);
      const res = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });
      expect(res.completed).toBe(false);

      // Give it the local evidence and it completes on the original rule.
      const now = new Date().toISOString();
      await db
        .prepare(`INSERT INTO payments (order_id, status, amount, created_at) VALUES (?, 'verified', 100, ?)`)
        .run(id, now);
      await db
        .prepare(`INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'dispatched', ?)`)
        .run(id, now);

      expect(await isPaid(id)).toBe(true);
      expect(await isShipped(id)).toBe(true);
      const after = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });
      expect(after.completed).toBe(true);
      // And it is NOT attributed to Zoho.
      const ev = await db
        .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ORDER_COMPLETED'")
        .get(id);
      expect(JSON.parse(ev.metadata).doneInZoho).toBe(false);
      expect(ev.notes).toMatch(/shipped and paid/i);
    });
  });

  describe('isDoneInZoho', () => {
    const imported = (over) => ({ getmeds_order_id: 'ZOHO-SO-1', ...over });

    test.each([
      [imported({ zoho_so_status: 'fulfilled' }), true],
      [imported({ zoho_order_status: 'closed' }), true],
      [imported({ zoho_so_status: 'shipped', zoho_order_status: 'open' }), false],
      [imported({ zoho_so_status: 'draft' }), false],
      [imported({}), false],
      [{}, false]
    ])('%o -> %s', (order, expected) => {
      expect(isDoneInZoho(order)).toBe(expected);
    });

    test('an order raised in THIS app is never short-circuited, whatever Zoho says', () => {
      // Sep 10, 2026: the shortcut is for historical orders that have no local
      // payment or dispatch record and never will. An order raised here does
      // get both, from the reconcile, so the strict rule reaches the same
      // answer on evidence this app holds — and letting Zoho close one out
      // mid-flow would bypass the verification steps that are the point of
      // running it here.
      expect(isDoneInZoho({ getmeds_order_id: 'GM-20260910-0001', zoho_so_status: 'fulfilled', zoho_order_status: 'closed' })).toBe(false);
    });
  });

  test('a GM order is NOT completed by Zoho alone, even when Zoho says fulfilled', async () => {
    // The end-to-end counterpart of the unit test above. This order has Zoho
    // reporting fulfilled and closed, but no local payment and no dispatch
    // record — the strict rule must still refuse it.
    const id = await seed({
      ref: 'GM-COMPLETE-ZOHO-SAYS-DONE',
      status: 'ready_for_dispatch',
      zoho: { so: 'fulfilled', order: 'closed', invoiced: 'invoiced', paid: 'paid', shipped: 'fulfilled' }
    });

    const res = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });
    expect(res.completed).toBe(false);
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status).toBe('ready_for_dispatch');
  });

  test('the SAME data on an imported order does complete it', async () => {
    // Identical Zoho state, different prefix — proving the gate is the only
    // thing separating the two, and that it is the prefix doing the work.
    const id = await seed({
      ref: 'ZOHO-COMPLETE-ZOHO-SAYS-DONE',
      status: 'ready_for_dispatch',
      zoho: { so: 'fulfilled', order: 'closed', invoiced: 'invoiced', paid: 'paid', shipped: 'fulfilled' }
    });

    const res = await evaluateCompletion({ orderId: id, currentStatus: 'ready_for_dispatch' });
    expect(res.completed).toBe(true);
  });

  test('an already-completed order is not completed twice', async () => {
    const id = await seed({
      ref: 'ZOHO-COMPLETE-7',
      status: 'completed',
      zoho: { so: 'fulfilled', order: 'closed', paid: 'paid', shipped: 'fulfilled' }
    });
    const res = await evaluateCompletion({ orderId: id, currentStatus: 'completed' });

    expect(res.completed).toBe(true);
    const events = await db
      .prepare("SELECT COUNT(*) c FROM order_events WHERE order_id = ? AND event_type = 'ORDER_COMPLETED'")
      .get(id);
    expect(events.c).toBe(0);
  });

  test('a cancelled order is never quietly completed', async () => {
    const id = await seed({
      ref: 'ZOHO-COMPLETE-8',
      status: 'cancelled',
      zoho: { so: 'fulfilled', order: 'closed', paid: 'paid', shipped: 'fulfilled' }
    });
    const res = await evaluateCompletion({ orderId: id, currentStatus: 'cancelled' });
    expect(res.completed).toBe(false);
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status).toBe('cancelled');
  });
});
