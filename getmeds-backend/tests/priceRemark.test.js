/**
 * Sep 18, 2026 — a MedRep's note on why a line is priced the way it is
 * (a discount agreed with the customer, a rate override), visible to
 * Management and Finance wherever they review the order's items.
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

describe('Price remark on an order item', () => {
  let medrepToken, managerToken, customerId, productId;
  const createdOrderIds = [];

  beforeAll(async () => {
    medrepToken = await loginAs('medrep@getmeds.ph');
    managerToken = await loginAs('manager@getmeds.ph');
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;

    const ref = `FIXTURE-PRICEREMARK-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number,
                                address, is_active, zoho_contact_id, source)
         VALUES (?, 'credit', 100000, 'Contact', '09170000003', '1 Remark St, Manila', 1, ?, 'local')`
      )
      .run(`FIXTURE Price Remark Customer ${ref}`, ref);
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

  async function createOrder(items) {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(medrepToken))
      .send({ customer_id: customerId, customer_type: 'credit', delivery_address: '1 Remark St', items });
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);
    return res.body.data.order;
  }
  const getOrder = (id, token = medrepToken) =>
    request(app).get(`/api/orders/${id}`).set(auth(token)).then((r) => r.body.data);

  test('a remark on one line is kept, and only on that line', async () => {
    const order = await createOrder([
      { product_id: productId, quantity: 1, rate: 100, price_remark: 'Matched a competitor quote the customer showed' }
    ]);
    const { items } = await getOrder(order.id);
    expect(items).toHaveLength(1);
    expect(items[0].price_remark).toBe('Matched a competitor quote the customer showed');
  });

  test('no remark sent — stays null, never a blank string', async () => {
    const order = await createOrder([{ product_id: productId, quantity: 1, rate: 100 }]);
    const { items } = await getOrder(order.id);
    expect(items[0].price_remark).toBeNull();
  });

  test('trimmed and capped at 300 characters, same as the field everywhere else', async () => {
    const order = await createOrder([
      { product_id: productId, quantity: 1, rate: 100, price_remark: `  ${'x'.repeat(400)}  ` }
    ]);
    const { items } = await getOrder(order.id);
    expect(items[0].price_remark).toHaveLength(300);
    expect(items[0].price_remark.startsWith(' ')).toBe(false);
  });

  test('a remark never changes the line math', async () => {
    const order = await createOrder([
      { product_id: productId, quantity: 2, rate: 250, discount: 50, price_remark: 'Bulk order discount' }
    ]);
    const { items } = await getOrder(order.id);
    expect(items[0].unit_price).toBe(250);
    expect(items[0].discount_amount).toBe(50);
    expect(items[0].line_total).toBe(2 * 250 - 50);
  });

  test('PATCH /:id/items — Management adding a remark to an existing line, visible on re-read', async () => {
    const order = await createOrder([{ product_id: productId, quantity: 1, rate: 100 }]);
    const patch = await request(app)
      .patch(`/api/orders/${order.id}/items`)
      .set(auth(managerToken))
      .send({ items: [{ product_id: productId, quantity: 1, rate: 100, price_remark: 'Corrected after a call with the customer' }] });
    expect(patch.status).toBe(200);
    expect(patch.body.data.items[0].price_remark).toBe('Corrected after a call with the customer');

    const { items } = await getOrder(order.id, managerToken);
    expect(items[0].price_remark).toBe('Corrected after a call with the customer');
  });
});
