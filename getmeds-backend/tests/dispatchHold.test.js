/**
 * Sep 15, 2026 — Dispatch puts an order on hold, and the "On hold" view.
 *
 * Confirmed with the business: Dispatch's hold is a FLAG — the order keeps
 * its place (they can still prepare it), the MedRep and Management are told,
 * nothing changes in Zoho or the status. The "On hold" view shows every held
 * order: Dispatch's flags, and orders On Hold by Finance or Management.
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

describe('Dispatch hold', () => {
  let dispatchToken;
  let medrepToken;
  let medrepId;
  let customerId;
  const created = [];

  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  async function orderAt(status, { exceptionReason = null } = {}) {
    const ref = `GM-DHOLD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, zoho_so_id, exception_reason)
         VALUES (?, ?, ?, ?, 'credit', 9600, '1 Hold St', ?, ?)`
      )
      .run(ref, customerId, medrepId, status, `ZSO-${ref}`, exceptionReason);
    const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(row.id);
    return row;
  }

  const hold = (id, reason, token = dispatchToken) =>
    request(app).post(`/api/dispatch/orders/${id}/hold`).set(auth(token)).send({ reason });
  const lift = (id) => request(app).post(`/api/dispatch/orders/${id}/hold/lift`).set(auth(dispatchToken));
  const heldIds = async () =>
    (await request(app).get('/api/dispatch/on-hold').set(auth(dispatchToken))).body.data.orders.map((o) => o.id);

  test('holding flags the order, tells the MedRep, and changes nothing else', async () => {
    const order = await orderAt('ready_for_dispatch');
    const res = await hold(order.id, 'Item out of stock — please update the items');
    expect(res.status).toBe(200);
    expect(res.body.data.dispatch_hold.reason).toMatch(/out of stock/);

    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('ready_for_dispatch');
    const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, medrepId);
    expect(note.message).toMatch(/on hold by Dispatch: Item out of stock/);

    // Still in the queue (they can still prepare it), with the flag.
    const queued = (await request(app).get('/api/dispatch/queue').query({ search: order.getmeds_order_id }).set(auth(dispatchToken)))
      .body.data.orders[0];
    expect(queued.dispatch_hold.reason).toMatch(/out of stock/);
    // And the MedRep's order page says why.
    const page = await request(app).get(`/api/orders/${order.id}`).set(auth(medrepToken));
    expect(page.body.data.order.dispatch_hold.by).toBeTruthy();
  });

  test('the On hold view has Dispatch holds and orders On Hold by Finance, with the reason', async () => {
    const flagged = await orderAt('picking_packing');
    await hold(flagged.id, 'Wrong item or quantity — please check the order');
    const financeHeld = await orderAt('on_hold', { exceptionReason: 'Overdue invoices' });
    await db
      .prepare("INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name) VALUES (?, 'FINANCE_REJECTED', 'ready_for_finance_verified', 'on_hold', 'Finance Getmeds')")
      .run(financeHeld.id);

    const orders = (await request(app).get('/api/dispatch/on-hold').set(auth(dispatchToken))).body.data.orders;
    const f = orders.find((o) => o.id === flagged.id);
    const s = orders.find((o) => o.id === financeHeld.id);
    expect(f.dispatch_hold.reason).toMatch(/Wrong item/);
    expect(f.status_hold).toBeNull();
    expect(s.status_hold).toEqual(expect.objectContaining({ reason: 'Overdue invoices', by: 'Finance Getmeds' }));
  });

  test('lifting takes it off the On hold view; lifting twice, or holding twice, is refused', async () => {
    const order = await orderAt('ready_for_dispatch');
    await hold(order.id, 'Item out of stock — please update the items');
    expect((await hold(order.id, 'again')).body.error.code).toBe('ALREADY_HELD');
    expect((await lift(order.id)).status).toBe(200);
    expect(await heldIds()).not.toContain(order.id);
    expect((await lift(order.id)).body.error.code).toBe('NOT_HELD');
  });

  test('a reason is required; a MedRep cannot hold; not before Finance', async () => {
    const order = await orderAt('ready_for_dispatch');
    expect((await hold(order.id, '  ')).status).toBe(400);
    expect((await hold(order.id, 'x', medrepToken)).status).toBe(403);
    const early = await orderAt('ready_for_finance_verified');
    expect((await hold(early.id, 'Item out of stock')).body.error.code).toBe('NOT_HOLDABLE');
  });
});
