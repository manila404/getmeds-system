/**
 * Sep 15, 2026 — Management resumes an order that is On Hold / Exception.
 *
 * GM-20260915-0031 sat at Exception ("waiting for additional payment") with
 * no way back. Resume takes it back to the stage it was at before the hold
 * (read from the trail, through an on_hold → exception chain), or a stage
 * Management picks. Nothing goes to Zoho.
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

describe('Resume a held order', () => {
  let managerToken;
  let medrepToken;
  let medrepId;
  let customerId;
  const created = [];

  beforeAll(async () => {
    managerToken = await loginAs('manager@getmeds.ph');
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

  async function heldOrder(status, trail = [], reason = 'Waiting for additional payment') {
    const ref = `GM-RESUME-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, zoho_so_id, exception_reason)
         VALUES (?, ?, ?, ?, 'credit', 5000, '1 Resume St', ?, ?)`
      )
      .run(ref, customerId, medrepId, status, `ZSO-${ref}`, reason);
    const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(row.id);
    for (const [from, to] of trail) {
      await db
        .prepare("INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name) VALUES (?, 'EXCEPTION_SET', ?, ?, 'Veronica')")
        .run(row.id, from, to);
    }
    return row;
  }

  const resume = (id, body, token = managerToken) =>
    request(app).post(`/api/orders/${id}/resume`).set(auth(token)).send(body);

  test('goes back to the stage before the hold, through on_hold → exception', async () => {
    const order = await heldOrder('exception', [
      ['ready_for_finance_verified', 'ready_for_draft_invoice'],
      ['ready_for_draft_invoice', 'on_hold'],
      ['on_hold', 'exception']
    ]);
    const page = await request(app).get(`/api/orders/${order.id}`).set(auth(managerToken));
    expect(page.body.data.order.resume_to).toBe('ready_for_draft_invoice');

    const res = await resume(order.id, { reason: 'Additional payment received' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready_for_draft_invoice');

    const after = await db.prepare('SELECT status, exception_reason FROM orders WHERE id = ?').get(order.id);
    expect(after).toEqual({ status: 'ready_for_draft_invoice', exception_reason: null });
    const ev = await db
      .prepare("SELECT old_status, new_status, notes FROM order_events WHERE order_id = ? AND event_type = 'ORDER_RESUMED'")
      .get(order.id);
    expect(ev).toEqual(expect.objectContaining({ old_status: 'exception', new_status: 'ready_for_draft_invoice' }));
    expect(ev.notes).toMatch(/Additional payment received.*Waiting for additional payment/);
    const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, medrepId);
    expect(note.message).toMatch(/taken off Exception/);
  });

  test('Management can pick another stage', async () => {
    const order = await heldOrder('on_hold', [['ready_for_dispatch', 'on_hold']]);
    const res = await resume(order.id, { reason: 'Stock arrived', status: 'picking_packing' });
    expect(res.body.data.status).toBe('picking_packing');
  });

  test('no trail to go back to — asks for the stage', async () => {
    const order = await heldOrder('exception');
    expect((await resume(order.id, { reason: 'ok' })).body.error.code).toBe('CHOOSE_STAGE');
    expect((await resume(order.id, { reason: 'ok', status: 'ready_for_finance_verified' })).status).toBe(200);
  });

  test('reason required; bad stage, unheld order and MedRep refused', async () => {
    const order = await heldOrder('on_hold', [['ready_for_dispatch', 'on_hold']]);
    expect((await resume(order.id, { reason: '  ' })).status).toBe(400);
    expect((await resume(order.id, { reason: 'x', status: 'completed' })).body.error.code).toBe('INVALID_STAGE');
    expect((await resume(order.id, { reason: 'x' }, medrepToken)).status).toBe(403);
    const moving = await heldOrder('ready_for_dispatch', [], null);
    expect((await resume(moving.id, { reason: 'x' })).body.error.code).toBe('NOT_HELD');
  });
});
