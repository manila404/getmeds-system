/**
 * Sep 19, 2026 — Management can edit an order even after it already has a
 * Zoho Sales Order; a MedRep still cannot. Management's edit is pushed to
 * the real Sales Order (best-effort — the local edit is never undone if
 * that fails) and logged in the order's trail either way.
 *
 * This is the first write this app ever makes to an EXISTING Zoho Sales
 * Order (every other write is create-only) — see ZohoAdapter.js's header
 * note on why it's a deliberate, reviewed exception.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('Management edits an order already synced to Zoho', () => {
  let medrepToken, managerToken, medrepId, customerId, productId;
  const createdOrderIds = [];

  beforeAll(async () => {
    medrepToken = await loginAs('medrep@getmeds.ph');
    managerToken = await loginAs('manager@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;

    const ref = `FIXTURE-EDITSYNCED-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number,
                                address, is_active, zoho_contact_id, source)
         VALUES (?, 'credit', 100000, 'Contact', '09170000005', '1 Synced St, Manila', 1, ?, 'local')`
      )
      .run(`FIXTURE Edit-Synced Customer ${ref}`, ref);
    customerId = (await db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?').get(ref)).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  });

  // A real Zoho Sales Order, so there is something genuine to update — not
  // a fabricated zoho_so_id, since updateSalesOrder would then fail on a
  // Sales Order that doesn't exist, same as it correctly would live.
  async function syncedOrder() {
    const zohoRes = await zoho.createSalesOrder({
      getmeds_order_id: `GM-EDITSYNCED-${Date.now()}`,
      zoho_customer_id: (await db.prepare('SELECT zoho_contact_id FROM customers WHERE id = ?').get(customerId)).zoho_contact_id,
      items: [{ name: 'Fixture Item', quantity: 1, unit_price: 100, subtotal: 100 }],
      salesperson_name: 'NORTH | Juan dela Cruz',
      total_amount: 100
    });
    const ref = `GM-EDITSYNCED-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, delivery_notes, salesperson, zoho_so_id, zoho_so_number, zoho_sync_status)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 100, '1 Synced St', 'original notes',
                 'NORTH | Juan dela Cruz', ?, ?, 'synced')`
      )
      .run(ref, customerId, medrepId, zohoRes.salesorder.salesorder_id, zohoRes.salesorder.salesorder_number);
    const order = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    await db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total)
         VALUES (?, ?, 1, 100, 100, 100)`
      )
      .run(order.id, productId);
    createdOrderIds.push(order.id);
    return order;
  }

  test('a MedRep is still refused once the order is synced — unchanged', async () => {
    const order = await syncedOrder();
    const res = await request(app)
      .patch(`/api/orders/${order.id}/details`)
      .set(auth(medrepToken))
      .send({ delivery_notes: 'trying anyway' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SYNCED');
  });

  test('Management CAN edit details on a synced order, and it is pushed to the real Sales Order', async () => {
    const order = await syncedOrder();
    const res = await request(app)
      .patch(`/api/orders/${order.id}/details`)
      .set(auth(managerToken))
      .send({ delivery_notes: 'corrected by management', invoicing_from: '2mg Incorporated' });
    expect(res.status).toBe(200);
    expect(res.body.data.order.delivery_notes).toBe('corrected by management');
    expect(res.body.data.zoho_pushed).toBe(true);
    expect(res.body.data.zoho_error).toBeNull();

    // Actually reached the real Zoho Sales Order — invoicing_from is part
    // of what updateSalesOrder resends, and it decides the PDF Template
    // (see LiveZohoAdapter's TEMPLATE_ID_BY_INVOICING_FROM), so the
    // template on the Sales Order itself is proof the push carried it.
    const so = (await zoho.getSalesOrder(order.zoho_so_id)).salesorder;
    expect(so.template_name).toBe('2MG Template');

    const event = await db
      .prepare("SELECT notes, actor_name FROM order_events WHERE order_id = ? AND event_type = 'ORDER_DETAILS_EDITED' ORDER BY id DESC LIMIT 1")
      .get(order.id);
    expect(event.notes).toMatch(/already synced to Zoho/);
    expect(event.notes).toMatch(/Pushed to the Zoho Sales Order/);
  });

  test('Management CAN edit items on a synced order, and the new items are pushed', async () => {
    const order = await syncedOrder();
    const otherProduct = await db.prepare('SELECT id FROM products WHERE is_active = 1 AND id <> ? LIMIT 1').get(productId);
    const res = await request(app)
      .patch(`/api/orders/${order.id}/items`)
      .set(auth(managerToken))
      .send({ items: [{ product_id: otherProduct.id, quantity: 3, rate: 200 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.zoho_pushed).toBe(true);

    const so = (await zoho.getSalesOrder(order.zoho_so_id)).salesorder;
    expect(so.line_items).toHaveLength(1);
    expect(so.line_items[0].quantity).toBe(3);

    const event = await db
      .prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ORDER_ITEMS_EDITED' ORDER BY id DESC LIMIT 1")
      .get(order.id);
    expect(event.notes).toMatch(/already synced to Zoho/);
    expect(event.notes).toMatch(/Pushed to the Zoho Sales Order/);
  });

  test('a failed push never undoes the local edit — it is reported, not blocked', async () => {
    const order = await syncedOrder();
    const spy = jest.spyOn(zoho, 'updateSalesOrder').mockRejectedValueOnce(new Error('Zoho is unreachable right now'));
    try {
      const res = await request(app)
        .patch(`/api/orders/${order.id}/details`)
        .set(auth(managerToken))
        .send({ delivery_notes: 'kept locally regardless' });
      expect(res.status).toBe(200);
      expect(res.body.data.order.delivery_notes).toBe('kept locally regardless');
      expect(res.body.data.zoho_pushed).toBe(false);
      expect(res.body.data.zoho_error).toMatch(/unreachable/);
    } finally {
      spy.mockRestore();
    }

    const event = await db
      .prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ORDER_DETAILS_EDITED' ORDER BY id DESC LIMIT 1")
      .get(order.id);
    expect(event.notes).toMatch(/Could NOT push to Zoho/);
  });
});
