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

  test('the order page is told it can be re-submitted — only for a Finance hold', async () => {
    const financeHold = await heldOrder();
    const otherHold = await heldOrder('picking_packing');
    const a = await request(app).get(`/api/orders/${financeHold}`).set(auth(medrepToken));
    const b = await request(app).get(`/api/orders/${otherHold}`).set(auth(medrepToken));
    expect(a.body.data.order.resubmittable).toBe(true);
    expect(b.body.data.order.resubmittable).toBe(false);
  });

  test('a hold someone other than Finance put on is refused, and says who to ask', async () => {
    const id = await heldOrder('picking_packing');
    const res = await resubmit(id, 'Proof of payment uploaded');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_FINANCE_HOLD');
    expect(await statusOf(id)).toBe('on_hold');
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
});
