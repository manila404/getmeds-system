/**
 * Sep 15, 2026 — the MedRep re-submits an order Finance held, with a reason.
 *
 * GM-20260915-0001: held by Finance twice ("Overdue GPI-SI000002378 and
 * GPI-SI000002275"), and each time returned only when Finance reopened it
 * themselves — the fix happened outside the order (the customer paid), so no
 * upload or edit was there to send it back.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('re-submitting a held order to Finance', () => {
  let medrepToken;
  let dispatchToken;
  let medrepId;
  let customerId;
  const created = [];

  beforeAll(async () => {
    medrepToken = await loginAs('medrep@getmeds.ph');
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  /** On hold, with a trail saying which status the hold was applied from. */
  async function heldOrder(heldFrom = 'ready_for_finance_verified') {
    const ref = `GM-RESUB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, exception_reason)
         VALUES (?, ?, ?, 'on_hold', 'credit', 35000, '1 Hold St', 'Overdue GPI-SI000002378')`
      )
      .run(ref, customerId, medrepId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(id);
    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, notes)
         VALUES (?, 'FINANCE_REJECTED', ?, 'on_hold', 'Finance Getmeds', 'held for the test')`
      )
      .run(id, heldFrom);
    return id;
  }

  const resubmit = (id, reason, token = medrepToken) =>
    request(app).post(`/api/orders/${id}/resubmit`).set(auth(token)).send({ reason });
  const statusOf = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;

  test('goes back to Finance, with the reason on the trail and in their notification', async () => {
    const id = await heldOrder();
    const res = await resubmit(id, 'Customer has settled the overdue balance');
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('ready_for_finance_verified');

    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'RETURNED_TO_FINANCE'").get(id);
    expect(ev.notes).toMatch(/Re-submitted for verification by .*: Customer has settled the overdue balance/);
    const financeIds = (await db.prepare("SELECT id FROM users WHERE role = 'finance'").all()).map((u) => u.id);
    const notes = await db.prepare('SELECT recipient_id, message FROM notifications WHERE order_id = ?').all(id);
    expect(notes.some((n) => financeIds.includes(n.recipient_id) && /settled the overdue balance/.test(n.message))).toBe(true);
  });

  test('the order page is told it can be re-submitted — a Finance hold, or any hold/exception whose prior stage is known', async () => {
    const financeHold = await heldOrder();
    const otherHold = await heldOrder('picking_packing');
    const unresolvable = await heldOrder('draft'); // 'draft' is not a resumable stage
    const a = await request(app).get(`/api/orders/${financeHold}`).set(auth(medrepToken));
    const b = await request(app).get(`/api/orders/${otherHold}`).set(auth(medrepToken));
    const c = await request(app).get(`/api/orders/${unresolvable}`).set(auth(medrepToken));
    expect(a.body.data.order.resubmittable).toBe(true);
    expect(b.body.data.order.resubmittable).toBe(true);
    expect(c.body.data.order.resubmittable).toBe(false);
  });

  // Sep 19, 2026: this used to be refused outright ("Ask Management to
  // release it") — resubmit now resolves a non-Finance hold the same way
  // "Resume order" would, back to wherever the trail says it was before.
  test('a hold Management put on resubmits back to its prior stage, not to Finance', async () => {
    const id = await heldOrder('picking_packing');
    const res = await resubmit(id, 'Stock is back — re-picking now');
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('picking_packing');

    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ORDER_RESUBMITTED'").get(id);
    expect(ev.notes).toMatch(/Stock is back — re-picking now/);
    // exception_reason is cleared the same way exports.resume clears it — a
    // held order that resubmits no longer shows a stale hold reason.
    expect((await db.prepare('SELECT exception_reason FROM orders WHERE id = ?').get(id)).exception_reason).toBeNull();
  });

  test('a hold with no resolvable prior stage is refused, and says who to ask', async () => {
    const id = await heldOrder('draft');
    const res = await resubmit(id, 'Proof of payment uploaded');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_RESUBMIT');
    expect(await statusOf(id)).toBe('on_hold');
  });

  test('an order Management put in exception also resubmits back to its prior stage', async () => {
    const ref = `GM-RESUB-EXC-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, exception_reason)
         VALUES (?, ?, ?, 'exception', 'credit', 35000, '1 Hold St', 'Waiting on additional payment')`
      )
      .run(ref, customerId, medrepId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(id);
    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, notes)
         VALUES (?, 'EXCEPTION_SET', 'ready_for_dispatch', 'exception', 'Management Getmeds', 'held for the test')`
      )
      .run(id);

    const res = await resubmit(id, 'Additional payment received');
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('ready_for_dispatch');
  });

  test('a reason is required', async () => {
    const id = await heldOrder();
    expect((await resubmit(id, '   ')).status).toBe(400);
    expect(await statusOf(id)).toBe('on_hold');
  });

  test('an order that is not on hold is refused', async () => {
    const id = await heldOrder();
    await resubmit(id, 'Proof of payment uploaded');
    const again = await resubmit(id, 'Proof of payment uploaded');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_ON_HOLD');
  });

  test('Dispatch cannot re-submit an order', async () => {
    const id = await heldOrder();
    expect((await resubmit(id, 'Proof of payment uploaded', dispatchToken)).status).toBe(403);
  });

  // Sep 19, 2026: "the finance will see the resubmit in [their] queue" — the
  // MedRep's remarks used to only reach Finance's notification and the
  // order's own trail; now they ride on the queue row itself.
  describe('Finance sees the resubmit on their own queue', () => {
    let financeToken;
    beforeAll(async () => { financeToken = await loginAs('finance@getmeds.ph'); });

    const queueRow = async (id) => {
      const res = await request(app).get('/api/finance/queue').set(auth(financeToken)).query({ stage: 'actionable', limit: 100 });
      expect(res.status).toBe(200);
      return res.body.data.orders.find((o) => o.id === id);
    };

    test('a Finance-hold resubmit shows the remarks on the queue row', async () => {
      const id = await heldOrder();
      await resubmit(id, 'Customer has settled the overdue balance');
      const row = await queueRow(id);
      expect(row).toBeTruthy();
      expect(row.resubmitted_at).toBeTruthy();
      expect(row.resubmit_note).toMatch(/Customer has settled the overdue balance/);
    });

    test('a Management-hold resubmit that lands back at Finance also shows on the queue row', async () => {
      const ref = `GM-RESUB-EXC2-${Date.now()}`;
      await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                               delivery_address, exception_reason)
           VALUES (?, ?, ?, 'exception', 'credit', 35000, '1 Hold St', 'Needs a corrected slip')`
        )
        .run(ref, customerId, medrepId);
      const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
      created.push(id);
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, notes)
           VALUES (?, 'EXCEPTION_SET', 'ready_for_finance_verified', 'exception', 'Management Getmeds', 'held for the test')`
        )
        .run(id);

      const res = await resubmit(id, 'Uploaded the corrected slip');
      expect(res.status).toBe(200);
      expect(await statusOf(id)).toBe('ready_for_finance_verified');

      const row = await queueRow(id);
      expect(row.resubmitted_at).toBeTruthy();
      expect(row.resubmit_note).toMatch(/Uploaded the corrected slip/);
    });

    test('a fresh order that was never resubmitted shows nothing', async () => {
      const ref = `GM-RESUB-FRESH-${Date.now()}`;
      await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
           VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 1200, '1 Fresh St')`
        )
        .run(ref, customerId, medrepId);
      const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
      created.push(id);

      const row = await queueRow(id);
      expect(row.resubmitted_at).toBeNull();
      expect(row.resubmit_note).toBeNull();
    });
  });
});
