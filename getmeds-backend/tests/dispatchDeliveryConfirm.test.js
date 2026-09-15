/**
 * Sep 15, 2026 — Dispatch sees what is coming, prints the address, and
 * confirms the delivery.
 *
 * Confirmed with the business: "Confirm for delivery" only RECORDS who checked
 * the address and when — no status change, nothing sent to Zoho.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const created = [];
let dispatchToken;
let medrepToken;
let medrepId;
let customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token = dispatchToken) => ({ Authorization: `Bearer ${token}` });

async function orderAt(status, { zohoSoId = null, prefix = 'GM-DLV', address = '215 Rizal St, Cebu City' } = {}) {
  const ref = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, intake_receiver, intake_contact_no, zoho_so_id, zoho_so_number)
       VALUES (?, ?, ?, ?, 'credit', 1500, ?, 'Floremel Medina', '0917 555 0142', ?, ?)`
    )
    .run(ref, customerId, medrepId, status, address, zohoSoId, zohoSoId ? 'SO-DLV' : null);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  return row;
}

const recent = async () => (await request(app).get('/api/dispatch/recent').set(auth())).body.data;
const confirm = (id, token) => request(app).post(`/api/dispatch/orders/${id}/confirm-delivery`).set(auth(token));

describe('Dispatch: recent orders, the delivery slip, and confirming delivery', () => {
  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('a new draft Sales Order waiting on Finance shows as a heads-up', async () => {
    const draft = await orderAt('ready_for_finance_verified', { zohoSoId: `ZSO-${Date.now()}` });
    const notInZoho = await orderAt('ready_for_finance_verified');
    const data = await recent();
    const ids = data.new_draft_sos.map((o) => o.id);
    expect(ids).toContain(draft.id);
    expect(ids).not.toContain(notInZoho.id);
  });

  test('an order Finance confirmed shows under "Confirmed by Finance"; imported history does not', async () => {
    const verified = await orderAt('ready_for_draft_invoice', { zohoSoId: `ZSO-${Date.now()}` });
    const imported = await orderAt('ready_for_dispatch', { prefix: 'ZOHO-SO-DLV', zohoSoId: `ZSO-I-${Date.now()}` });
    const ids = (await recent()).finance_confirmed.map((o) => o.id);
    expect(ids).toContain(verified.id);
    expect(ids).not.toContain(imported.id);
  });

  test('confirming records who and when, and changes nothing else', async () => {
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
    const spies = ['createInvoiceFromSalesOrder', 'createPackageForSalesOrder', 'createShipmentForPackage', 'confirmSalesOrder']
      .map((m) => jest.spyOn(zoho, m));
    try {
      const res = await confirm(order.id);
      expect(res.status).toBe(200);
      expect(res.body.data.delivery_confirmed_by).toBeTruthy();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    const after = await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
    expect(after.status).toBe('ready_for_dispatch');
    const events = await db
      .prepare("SELECT notes, metadata FROM order_events WHERE order_id = ? AND event_type = 'DELIVERY_CONFIRMED'")
      .all(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].notes).toMatch(/215 Rizal St, Cebu City/);

    const row = (await recent()).finance_confirmed.find((o) => o.id === order.id);
    expect(row.delivery_confirmed_at).toBeTruthy();
    expect(row.delivery_address_changed).toBe(false);
    const queued = (await request(app).get('/api/dispatch/queue').set(auth())).body.data.orders.find((o) => o.id === order.id);
    expect(queued.delivery_confirmed_by).toBeTruthy();
  });

  test('an address edited after the confirmation shows as changed, not as still confirmed', async () => {
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
    await confirm(order.id);
    await db.prepare("UPDATE orders SET delivery_address = '9 New Address Ave, Makati' WHERE id = ?").run(order.id);
    const row = (await recent()).finance_confirmed.find((o) => o.id === order.id);
    expect(row.delivery_address_changed).toBe(true);
  });

  test('an order Finance has not confirmed cannot be confirmed for delivery', async () => {
    const order = await orderAt('ready_for_finance_verified', { zohoSoId: `ZSO-${Date.now()}` });
    const res = await confirm(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CONFIRMABLE');
  });

  test('an order with no delivery address cannot be confirmed', async () => {
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}`, address: '' });
    const res = await confirm(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_ADDRESS');
  });

  test('the slip carries the address, receiver and items', async () => {
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
    const product = await db.prepare('SELECT id, name FROM products LIMIT 1').get();
    await db
      .prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 3, 100, 300, 300)')
      .run(order.id, product.id);
    const res = await request(app).get(`/api/dispatch/orders/${order.id}/slip`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.order.delivery_address).toBe('215 Rizal St, Cebu City');
    expect(res.body.data.order.intake_receiver).toBe('Floremel Medina');
    expect(res.body.data.items).toEqual([expect.objectContaining({ name: product.name, quantity: 3 })]);
  });

  test('a MedRep can do none of this', async () => {
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
    expect((await request(app).get('/api/dispatch/recent').set(auth(medrepToken))).status).toBe(403);
    expect((await confirm(order.id, medrepToken)).status).toBe(403);
  });

  test("Dispatch can open an order's receipt: the order, its items and its attachments", async () => {
    // Clicking an order on the Dispatch page opens the same panel Finance
    // uses, which reads these two endpoints.
    const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
    const product = await db.prepare('SELECT id FROM products LIMIT 1').get();
    await db
      .prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 2, 50, 100, 100)')
      .run(order.id, product.id);

    const detail = await request(app).get(`/api/orders/${order.id}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.data.order.delivery_address).toBe('215 Rizal St, Cebu City');
    expect(detail.body.data.items).toHaveLength(1);

    const files = await request(app).get(`/api/orders/${order.id}/attachments`).set(auth());
    expect(files.status).toBe(200);
    expect(Array.isArray(files.body.data.attachments)).toBe(true);
  });
});
