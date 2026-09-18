/**
 * Sep 18, 2026 — the order form warns a MedRep when an item they're
 * ordering has an open Dispatch stock announcement, and asks them to say
 * why they're proceeding anyway. "A warning, never a block"
 * (stockAnnouncements.controller.js): the order always goes through either
 * way — this only checks what gets RECORDED, for Dispatch and Management's
 * benefit, when it does.
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

describe('order creation against a flagged product', () => {
  let dispatchToken, medrepToken;
  let customerId, productId, dispatchId, managerId;
  const createdOrderIds = [];
  const createdAnnouncementIds = [];

  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    dispatchId = (await db.prepare("SELECT id FROM users WHERE email = 'dispatch@getmeds.ph'").get()).id;
    managerId = (await db.prepare("SELECT id FROM users WHERE role = 'management' LIMIT 1").get()).id;
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;

    const ref = `FIXTURE-STOCKWARN-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number,
                                address, is_active, zoho_contact_id, source)
         VALUES (?, 'credit', 100000, 'Contact', '09170000002', '1 Warn St, Manila', 1, ?, 'local')`
      )
      .run(`FIXTURE Stock Warning Customer ${ref}`, ref);
    customerId = (await db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?').get(ref)).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    for (const id of createdAnnouncementIds) await db.prepare('DELETE FROM stock_announcements WHERE id = ?').run(id);
    await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  });

  async function announce(kind = 'out_of_stock') {
    const res = await request(app)
      .post('/api/stock-announcements')
      .set(auth(dispatchToken))
      .send({ product_id: productId, kind, message: 'Fixture announcement' });
    createdAnnouncementIds.push(res.body.data.announcement.id);
    return res.body.data.announcement;
  }
  const resolveAnnouncement = (id) => request(app).post(`/api/stock-announcements/${id}/resolve`).set(auth(dispatchToken));

  async function raiseOrder(stockWarningNote) {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(medrepToken))
      .send({
        customer_id: customerId,
        customer_type: 'credit',
        delivery_address: '1 Warn St',
        items: [{ product_id: productId, quantity: 1, unit_price: 500 }],
        ...(stockWarningNote !== undefined ? { stock_warning_note: stockWarningNote } : {})
      });
    expect(res.status).toBe(201); // never blocks, whatever the note
    createdOrderIds.push(res.body.data.order.id);
    return res.body.data.order;
  }
  const eventsOf = (orderId) =>
    db.prepare("SELECT notes, metadata FROM order_events WHERE order_id = ? AND event_type = 'STOCK_WARNING_ACKNOWLEDGED'").all(orderId);
  const notifiedOf = (orderId, userId) =>
    db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(orderId, userId);

  test('no open announcement — nothing is logged', async () => {
    const order = await raiseOrder('a note nobody needed');
    expect(await eventsOf(order.id)).toHaveLength(0);
  });

  test('a flagged item with a note — logged with the note, Dispatch and Management notified', async () => {
    const a = await announce('out_of_stock');
    const order = await raiseOrder('Customer insists, will wait for restock');
    const events = await eventsOf(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].notes).toMatch(/out of stock/);
    expect(events[0].notes).toMatch(/Customer insists, will wait for restock/);
    expect(JSON.parse(events[0].metadata).note).toBe('Customer insists, will wait for restock');

    expect(await notifiedOf(order.id, dispatchId)).toBeTruthy();
    expect(await notifiedOf(order.id, managerId)).toBeTruthy();
    await resolveAnnouncement(a.id);
  });

  test('a flagged item with no note — still logged, says so', async () => {
    await announce('low_stock');
    const order = await raiseOrder(); // stock_warning_note omitted entirely
    const events = await eventsOf(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].notes).toMatch(/low stock/);
    expect(events[0].notes).toMatch(/No note given/);
  });

  test('back_in_stock / stock_update never trigger this — informational, not a problem', async () => {
    await announce('back_in_stock');
    const order = await raiseOrder('irrelevant note');
    expect(await eventsOf(order.id)).toHaveLength(0);
  });

  test('a resolved announcement no longer applies', async () => {
    const a = await announce('out_of_stock');
    await resolveAnnouncement(a.id);
    const order = await raiseOrder('note attached to nothing current');
    expect(await eventsOf(order.id)).toHaveLength(0);
  });
});
