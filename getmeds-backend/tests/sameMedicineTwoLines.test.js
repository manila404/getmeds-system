/**
 * Nov 14, 2026 (Aaron): the same medicine can be on two lines, one of them at ₱0. That is how a 2+1
 * or a special deal is entered (Sugamaget 2 at ₱300, Sugamaget 1 at ₱0), by a MedRep too.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'demo123' })).body.data.token;
const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

describe('same medicine on two lines', () => {
  let token, productId, customerId, orderId;
  const savedTestIds = process.env.ZOHO_TEST_CUSTOMER_IDS;
  const savedTestId = process.env.ZOHO_TEST_CUSTOMER_ID;
  beforeAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = '';
    process.env.ZOHO_TEST_CUSTOMER_ID = '';
    token = await login('medrep@getmeds.ph');
    await db.prepare('INSERT INTO products (name, sku, unit_price, stock, is_active) VALUES (?, ?, 300, 500, 1)').run(`Sugama Test ${stamp}`, `SUG-${stamp}`);
    productId = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(`SUG-${stamp}`)).id;
    await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Sugama Customer ${stamp}`, `SC-${stamp}`);
    customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Sugama Customer ${stamp}`)).id;
  });
  afterAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = savedTestIds || '';
    process.env.ZOHO_TEST_CUSTOMER_ID = savedTestId || '';
    if (orderId) {
      for (const t of ['order_items', 'order_events', 'notifications', 'zoho_sync_queue']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(orderId);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    }
  });

  test('a MedRep order keeps both lines: 2 at ₱300 and 1 at ₱0', async () => {
    const res = await request(app).post('/api/orders').set({ Authorization: `Bearer ${token}` }).send({
      customer_id: customerId, status: 'draft', delivery_address: '1 Sugama St',
      items: [{ product_id: productId, quantity: 2, rate: 300 }, { product_id: productId, quantity: 1, rate: 0 }]
    });
    expect([res.status, res.body?.error?.message]).toEqual([201, undefined]);
    orderId = res.body.data.order.id;
    const lines = await db.prepare('SELECT quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
    expect(lines.map((l) => [Number(l.quantity), Number(l.unit_price)])).toEqual([[2, 300], [1, 0]]);
    expect(Number(res.body.data.order.total_amount)).toBe(600);
  });
});
