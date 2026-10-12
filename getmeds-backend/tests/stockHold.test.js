/**
 * Oct 12, 2026 — a draft waiting for stock (instead of cancelling it), and "Stock is back".
 * The order stays a draft; orders.stock_hold_* mark it. Released straight to Management approval.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const stockHoldService = require('../src/services/stockHoldService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const created = [];
let mgr, rep, fin, medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function draft() {
  const ref = `GM-HLD-${stamp}-${created.length}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
       VALUES (?, ?, ?, 'draft', 'direct', 3000, '1 Hold St')`
    )
    .run(ref, customerId, medrepId);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  created.push(id);
  return id;
}
const hold = (id, body = { reason: 'HYDROXYGET out of stock', item: 'HYDROXYGET' }, token = mgr) =>
  request(app).post(`/api/orders/${id}/stock-hold`).set(auth(token)).send(body);
const release = (id, token = rep) => request(app).post(`/api/orders/${id}/stock-release`).set(auth(token)).send({});
const row = (id) => db.prepare('SELECT status, stock_hold_at, stock_hold_reason, draft_cancelled_at FROM orders WHERE id = ?').get(id);

beforeAll(async () => {
  mgr = await loginAs('manager@getmeds.ph');
  rep = await loginAs('medrep@getmeds.ph');
  fin = await loginAs('finance@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
});

afterAll(async () => {
  for (const id of created) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
});

describe('waiting for stock', () => {
  test('Management holds a draft; it stays a draft and is marked', async () => {
    const id = await draft();
    expect((await hold(id)).status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe('draft');
    expect(r.stock_hold_at).not.toBeNull();
    expect(r.stock_hold_reason).toBe('HYDROXYGET out of stock');
    expect((await hold(id)).status).toBe(409); // already held
  });

  test('a reason is required, and only Management / Admin can hold', async () => {
    const id = await draft();
    expect((await hold(id, {})).status).toBe(400);
    expect((await hold(id, { reason: 'x' }, rep)).status).toBe(403);
    expect((await row(id)).stock_hold_at).toBeNull();
  });

  test('the MedRep who owns the draft can release it, straight to Management approval', async () => {
    const id = await draft();
    await hold(id);
    const res = await release(id, rep);
    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe('pending_management_approval');
    expect(r.stock_hold_at).toBeNull();
    expect((await release(id, rep)).status).toBe(409); // nothing left to release
  });

  test('Finance cannot release, and an order that is not held cannot be released', async () => {
    const id = await draft();
    await hold(id);
    expect((await release(id, fin)).status).toBe(403);
    const other = await draft();
    expect((await release(other, rep)).status).toBe(409);
  });

  test('cancelling a held draft clears the marker', async () => {
    const id = await draft();
    await hold(id);
    const res = await request(app).post(`/api/orders/${id}/cancel-draft`).set(auth(mgr)).send({ reason: 'Customer gave up', kind: 'keep_record' });
    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe('cancelled');
    expect(r.stock_hold_at).toBeNull();
  });

  test('the reminder fires after 3 days, once per 3 days', async () => {
    const id = await draft();
    await hold(id);
    const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString();
    await db.prepare('UPDATE orders SET stock_hold_at = ? WHERE id = ?').run(fourDaysAgo, id);
    const first = await stockHoldService.remindDue();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const again = await stockHoldService.remindDue();
    const stillDue = await db.prepare('SELECT stock_hold_reminded_at FROM orders WHERE id = ?').get(id);
    expect(stillDue.stock_hold_reminded_at).not.toBeNull();
    expect(again.reminded).toBe(0);
  });
});
