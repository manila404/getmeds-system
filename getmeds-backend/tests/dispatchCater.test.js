/**
 * Sep 15, 2026 — a Dispatch person caters (takes on) an order.
 *
 * Several people work the Dispatch queue and nothing said who had which
 * order, so two could prepare the same one. Confirmed with the business: a
 * label, not a lock — others see who caters it and may take it over; any order
 * in Dispatch, imported history included. "My orders" is the ones I cater.
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

describe('Dispatch catering orders', () => {
  let dispatchA;
  let dispatchB;
  let adminToken;
  let medrepToken;
  let dispatchAId;
  let dispatchBId;
  let medrepId;
  let customerId;
  const created = [];
  const createdUsers = [];

  beforeAll(async () => {
    dispatchA = await loginAs('dispatch@getmeds.ph');
    dispatchAId = (await db.prepare("SELECT id FROM users WHERE email = 'dispatch@getmeds.ph'").get()).id;
    // A second Dispatch person, the way workflowV2.test.js makes its manager:
    // the seeded rep's password hash, so loginAs works without bcrypt here.
    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const emailB = `cater-b-${Date.now()}@getmeds.ph`;
    await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'dispatch')")
      .run('Second Dispatcher', emailB, seed.password_hash);
    dispatchBId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(emailB)).id;
    createdUsers.push(dispatchBId);
    dispatchB = await loginAs(emailB);
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUsers) {
      await db.prepare('DELETE FROM order_events WHERE actor_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  });

  async function orderAt(status, prefix = 'GM-CATER') {
    const ref = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, ?, 'credit', 1800, '1 Cater St')`
      )
      .run(ref, customerId, medrepId, status);
    const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(row.id);
    return row;
  }

  const cater = (id, token) => request(app).post(`/api/dispatch/orders/${id}/cater`).set(auth(token));
  const release = (id, token) => request(app).post(`/api/dispatch/orders/${id}/cater/release`).set(auth(token));
  const myOrderIds = async (token) =>
    (await request(app).get('/api/orders').query({ catered: 'mine', limit: 100 }).set(auth(token))).body.data.orders.map((o) => o.id);
  const queueRow = async (order, token = dispatchA) =>
    (await request(app).get('/api/dispatch/queue').query({ search: order.getmeds_order_id }).set(auth(token))).body.data.orders[0];

  test('catering puts the order on my list, and everyone sees who has it', async () => {
    const order = await orderAt('ready_for_dispatch');
    const res = await cater(order.id, dispatchA);
    expect(res.status).toBe(200);
    expect(res.body.data.catered.by_id).toBe(dispatchAId);

    expect(await myOrderIds(dispatchA)).toContain(order.id);
    expect(await myOrderIds(dispatchB)).not.toContain(order.id);
    expect((await queueRow(order, dispatchB)).catered.by_id).toBe(dispatchAId);
    // A label: nothing about the order itself changes.
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('ready_for_dispatch');
  });

  test('another Dispatch person can take it over, and the trail says from whom', async () => {
    const order = await orderAt('picking_packing');
    await cater(order.id, dispatchA);
    const res = await cater(order.id, dispatchB);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/taken over/);
    expect(await myOrderIds(dispatchA)).not.toContain(order.id);
    expect(await myOrderIds(dispatchB)).toContain(order.id);
    const last = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'DISPATCH_CATERED' ORDER BY id DESC LIMIT 1").get(order.id);
    expect(last.notes).toMatch(/taken over from/);
  });

  test('catering an order you already cater changes nothing', async () => {
    const order = await orderAt('ready_for_dispatch');
    await cater(order.id, dispatchA);
    expect((await cater(order.id, dispatchA)).status).toBe(200);
    const events = await db.prepare("SELECT 1 FROM order_events WHERE order_id = ? AND event_type = 'DISPATCH_CATERED'").all(order.id);
    expect(events).toHaveLength(1);
  });

  test('released by the one catering it, or Management — not by another Dispatch person', async () => {
    const order = await orderAt('ready_for_dispatch');
    await cater(order.id, dispatchA);
    expect((await release(order.id, dispatchB)).status).toBe(403);
    expect((await release(order.id, dispatchA)).status).toBe(200);
    expect(await myOrderIds(dispatchA)).not.toContain(order.id);
    expect((await queueRow(order)).catered).toBeNull();

    await cater(order.id, dispatchA);
    expect((await release(order.id, adminToken)).status).toBe(200);
    expect((await release(order.id, adminToken)).body.error.code).toBe('NOT_CATERED');
  });

  test('the queue shows mine, or the ones nobody caters yet', async () => {
    const tag = `CATERQ${Date.now()}`;
    const mine = await orderAt('ready_for_dispatch', `GM-${tag}`);
    const open = await orderAt('ready_for_dispatch', `GM-${tag}`);
    await cater(mine.id, dispatchA);
    const q = async (cater) =>
      (await request(app).get('/api/dispatch/queue').query({ search: tag, cater }).set(auth(dispatchA))).body.data.orders.map((o) => o.id);
    expect(await q('mine')).toEqual([mine.id]);
    expect(await q('open')).toEqual([open.id]);
  });

  test('any order in Dispatch, imported ones included — but not before Finance', async () => {
    const imported = await orderAt('dispatched', 'ZOHO-SO-CATER');
    expect((await cater(imported.id, dispatchA)).status).toBe(200);
    const early = await orderAt('ready_for_finance_verified');
    const res = await cater(early.id, dispatchA);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CATERABLE');
  });

  test('a MedRep cannot cater an order', async () => {
    const order = await orderAt('ready_for_dispatch');
    expect((await cater(order.id, medrepToken)).status).toBe(403);
  });
});
