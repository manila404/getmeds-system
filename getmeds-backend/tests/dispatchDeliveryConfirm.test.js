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
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
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

  describe('tracking number on hold', () => {
    const hold = (id, body, token) =>
      request(app).post(`/api/dispatch/orders/${id}/tracking-hold`).set(auth(token)).send(body);
    const release = (id) => request(app).post(`/api/dispatch/orders/${id}/tracking-hold/release`).set(auth());

    test('records the reason, tells the MedRep, and changes nothing else', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      await confirm(order.id);
      const notificationService = require('../src/services/notificationService');
      const spy = jest.spyOn(notificationService, 'notify');
      try {
        const res = await hold(order.id, { reason: 'Waiting for waybill', note: 'LBC says tomorrow' });
        expect(res.status).toBe(200);
        expect(res.body.data.tracking_hold.reason).toBe('Waiting for waybill');
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: expect.arrayContaining([medrepId]) }));
      } finally {
        spy.mockRestore();
      }

      expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('ready_for_dispatch');
      const row = (await recent()).finance_confirmed.find((o) => o.id === order.id);
      expect(row.tracking_hold).toEqual(expect.objectContaining({ reason: 'Waiting for waybill', note: 'LBC says tomorrow' }));
      const queued = (await request(app).get('/api/dispatch/queue').set(auth())).body.data.orders.find((o) => o.id === order.id);
      expect(queued.tracking_hold.reason).toBe('Waiting for waybill');
    });

    test('"Tracking ready" lifts it; lifting one not on hold is refused', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      await hold(order.id, { reason: 'Waiting for courier pickup' });
      expect((await release(order.id)).status).toBe(200);
      const row = (await recent()).finance_confirmed.find((o) => o.id === order.id);
      expect(row.tracking_hold).toBeNull();
      expect((await release(order.id)).status).toBe(409);
    });

    test('a hold counts as lifted once the order has a tracking number', async () => {
      const order = await orderAt('dispatched', { zohoSoId: `ZSO-${Date.now()}` });
      expect((await hold(order.id, { reason: 'Waiting for waybill' })).status).toBe(200);
      await db.prepare("INSERT INTO dispatch_records (order_id, status, tracking_number) VALUES (?, 'dispatched', 'LBC-123')").run(order.id);
      const queued = (await request(app).get('/api/dispatch/queue').set(auth())).body.data.orders.find((o) => o.id === order.id);
      expect(queued.tracking_hold).toBeNull();
      expect((await hold(order.id, { reason: 'Waiting for waybill' })).body.error.code).toBe('HAS_TRACKING');
    });

    test('needs a reason, and only for an order on its way through Dispatch', async () => {
      const ready = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      expect((await hold(ready.id, { reason: '  ' })).status).toBe(400);
      const early = await orderAt('ready_for_finance_verified', { zohoSoId: `ZSO-${Date.now()}` });
      expect((await hold(early.id, { reason: 'Waiting for waybill' })).body.error.code).toBe('NOT_HOLDABLE');
      expect((await hold(ready.id, { reason: 'Waiting for waybill' }, medrepToken)).status).toBe(403);
    });
  });

  describe('confirming, with the tracking number added or on hold in the same step', () => {
    const confirmWith = (id, body) =>
      request(app).post(`/api/dispatch/orders/${id}/confirm-delivery`).set(auth()).send(body);

    test('with the tracking number: saved, the MedRep told, nothing else changed', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      const res = await confirmWith(order.id, { tracking: { courier: 'LBC Express', tracking_number: '1234 5678 9012' } });
      expect(res.status).toBe(200);
      expect(res.body.data.entered_tracking).toEqual(expect.objectContaining({ courier: 'LBC Express', tracking_number: '1234 5678 9012' }));

      const types = (await db.prepare('SELECT event_type FROM order_events WHERE order_id = ? ORDER BY id').all(order.id)).map((e) => e.event_type);
      expect(types).toEqual(['DELIVERY_CONFIRMED', 'DISPATCH_TRACKING_ADDED']);
      const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, medrepId);
      expect(note.message).toMatch(/1234 5678 9012/);
      expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('ready_for_dispatch');
      // Record-only: Dispatch's number does not pose as Zoho's shipment.
      expect(await db.prepare('SELECT 1 FROM dispatch_records WHERE order_id = ?').get(order.id)).toBeUndefined();

      const row = (await recent()).finance_confirmed.find((o) => o.id === order.id);
      expect(row.entered_tracking.tracking_number).toBe('1234 5678 9012');
    });

    test('waiting for the waybill: confirmed, and the tracking on hold', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      const res = await confirmWith(order.id, { hold: { reason: 'Waiting for waybill' } });
      expect(res.status).toBe(200);
      expect(res.body.data.tracking_hold.reason).toBe('Waiting for waybill');
      expect(res.body.data.delivery_confirmed_at).toBeTruthy();
    });

    test('both at once, or a tracking number without one, is refused before anything is saved', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      expect((await confirmWith(order.id, { tracking: { courier: 'LBC', tracking_number: '1' }, hold: { reason: 'x' } })).status).toBe(400);
      expect((await confirmWith(order.id, { tracking: { courier: 'LBC', tracking_number: ' ' } })).status).toBe(400);
      const events = await db.prepare('SELECT 1 FROM order_events WHERE order_id = ?').all(order.id);
      expect(events).toHaveLength(0);
    });

    test('adding the number later ends the hold; after that it cannot be held or added again', async () => {
      const order = await orderAt('ready_for_dispatch', { zohoSoId: `ZSO-${Date.now()}` });
      await confirmWith(order.id, { hold: { reason: 'Waiting for waybill' } });
      const add = await request(app)
        .post(`/api/dispatch/orders/${order.id}/tracking`)
        .set(auth())
        .send({ courier: 'J&T', tracking_number: 'JT0001' });
      expect(add.status).toBe(200);
      expect(add.body.data.tracking_hold).toBeNull();
      expect(add.body.data.entered_tracking.tracking_number).toBe('JT0001');

      const again = await request(app).post(`/api/dispatch/orders/${order.id}/tracking`).set(auth()).send({ courier: 'J&T', tracking_number: 'JT0002' });
      expect(again.body.error.code).toBe('HAS_TRACKING');
      const holdAfter = await request(app).post(`/api/dispatch/orders/${order.id}/tracking-hold`).set(auth()).send({ reason: 'Waiting for waybill' });
      expect(holdAfter.body.error.code).toBe('HAS_TRACKING');
    });
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
