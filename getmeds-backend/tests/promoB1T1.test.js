/**
 * Nov 14, 2026 (Aaron): Buy 1 Take 1. Dispatch or Finance announce it on a product; every new order
 * with that product gets the same quantity again, free (₱0), added by the server.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { applyB1T1, activeB1T1ProductIds } = require('../src/services/promoService');

const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'demo123' })).body.data.token;
const as = (t) => ({ Authorization: `Bearer ${t}` });
const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

describe('applyB1T1 (the rule)', () => {
  const promo = new Set([1]);
  const line = (product_id, quantity, unit_price) => ({ product_id, quantity, unit_price, subtotal: quantity * unit_price, line_total: quantity * unit_price, name: `P${product_id}` });

  test('adds the same quantity free, at ₱0, after the paid line', () => {
    const { lines, added } = applyB1T1([line(1, 30, 35), line(2, 5, 10)], promo);
    expect(lines).toHaveLength(3);
    const free = lines[2];
    expect(free).toMatchObject({ product_id: 1, quantity: 30, unit_price: 0, line_total: 0 });
    expect(added).toEqual([{ product_id: 1, name: 'P1', quantity: 30 }]);
  });

  test('a free line typed by hand is replaced, so free always equals bought (never more)', () => {
    const { lines } = applyB1T1([line(1, 30, 35), line(1, 99, 0)], promo);
    expect(lines.filter((l) => l.unit_price === 0).map((l) => l.quantity)).toEqual([30]);
  });

  test('two paid lines of the product give one free line with their total', () => {
    const { lines } = applyB1T1([line(1, 10, 35), line(1, 20, 30)], promo);
    expect(lines.filter((l) => l.unit_price === 0).map((l) => l.quantity)).toEqual([30]);
  });

  test('a product with only a ₱0 line (a free sample) is left alone; other products untouched', () => {
    const input = [line(1, 5, 0), line(2, 5, 10)];
    expect(applyB1T1(input, promo).lines).toEqual(input);
    expect(applyB1T1(input, new Set()).lines).toBe(input);
  });
});

describe('announcing it', () => {
  let financeToken, dispatchToken, productId;
  beforeAll(async () => {
    financeToken = await login('finance@getmeds.ph');
    dispatchToken = await login('dispatch@getmeds.ph');
    await db.prepare('INSERT INTO products (name, sku, unit_price, stock, is_active) VALUES (?, ?, 35, 500, 1)').run(`Promo Med ${stamp}`, `PROMO-${stamp}`);
    productId = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(`PROMO-${stamp}`)).id;
  });
  afterAll(async () => {
    await db.prepare('DELETE FROM stock_announcements WHERE product_id = ?').run(productId);
  });

  test('Finance can post a Buy 1 Take 1 promo, but not a stock announcement', async () => {
    expect((await request(app).post('/api/stock-announcements').set(as(financeToken)).send({ product_id: productId, kind: 'low_stock' })).status).toBe(403);
    const res = await request(app).post('/api/stock-announcements').set(as(financeToken)).send({ product_id: productId, kind: 'promo_b1t1' });
    expect(res.status).toBe(201);
    expect((await activeB1T1ProductIds()).has(productId)).toBe(true);
  });

  test('a stock announcement does not end the promo (they live side by side)', async () => {
    expect((await request(app).post('/api/stock-announcements').set(as(dispatchToken)).send({ product_id: productId, kind: 'low_stock' })).status).toBe(201);
    expect((await activeB1T1ProductIds()).has(productId)).toBe(true);
    const open = (await request(app).get('/api/stock-announcements').set(as(dispatchToken))).body.data.announcements.filter((a) => a.product_id === productId);
    expect(open.map((a) => a.kind).sort()).toEqual(['low_stock', 'promo_b1t1']);
  });

  test('Finance can end the promo but not a stock announcement', async () => {
    const open = (await request(app).get('/api/stock-announcements').set(as(financeToken))).body.data.announcements.filter((a) => a.product_id === productId);
    const stock = open.find((a) => a.kind === 'low_stock');
    const promo = open.find((a) => a.kind === 'promo_b1t1');
    expect((await request(app).post(`/api/stock-announcements/${stock.id}/resolve`).set(as(financeToken))).status).toBe(404);
    expect((await request(app).post(`/api/stock-announcements/${promo.id}/resolve`).set(as(financeToken))).status).toBe(200);
    expect((await activeB1T1ProductIds()).has(productId)).toBe(false);
  });
});

describe('creating an order with a promo product', () => {
  let token, productId, orderId, customerId;
  // The .env "TEST customers only" safety switch would refuse this order; Zoho is the mock here.
  const savedTestIds = process.env.ZOHO_TEST_CUSTOMER_IDS;
  const savedTestId = process.env.ZOHO_TEST_CUSTOMER_ID;
  beforeAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = '';
    process.env.ZOHO_TEST_CUSTOMER_ID = '';
    token = await login('manager@getmeds.ph');
    await db.prepare('INSERT INTO products (name, sku, unit_price, stock, is_active) VALUES (?, ?, 35, 500, 1)').run(`Promo Order Med ${stamp}`, `PROMO-O-${stamp}`);
    productId = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(`PROMO-O-${stamp}`)).id;
    await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Promo Customer ${stamp}`, `PC-${stamp}`);
    customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Promo Customer ${stamp}`)).id;
    const by = (await db.prepare("SELECT id, name FROM users WHERE email = 'dispatch@getmeds.ph'").get());
    await db.prepare("INSERT INTO stock_announcements (product_id, kind, created_by, created_by_name, created_at) VALUES (?, 'promo_b1t1', ?, ?, ?)").run(productId, by.id, by.name, new Date().toISOString());
  });
  afterAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = savedTestIds || '';
    process.env.ZOHO_TEST_CUSTOMER_ID = savedTestId || '';
    if (orderId) {
      for (const t of ['order_items', 'order_events', 'notifications', 'zoho_sync_queue']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(orderId);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    }
    await db.prepare('DELETE FROM stock_announcements WHERE product_id = ?').run(productId);
  });

  test('the free line is added by the server, same quantity, ₱0, total unchanged', async () => {
    const res = await request(app).post('/api/orders').set(as(token)).send({
      customer_id: customerId, status: 'draft', delivery_address: '1 Promo St',
      items: [{ product_id: productId, quantity: 30, rate: 35 }]
    });
    expect([res.status, res.body?.error?.message]).toEqual([201, undefined]);
    orderId = res.body.data.order.id;
    const lines = await db.prepare('SELECT quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
    expect(lines.map((l) => [Number(l.quantity), Number(l.unit_price)])).toEqual([[30, 35], [30, 0]]);
    expect(Number(res.body.data.order.total_amount)).toBe(1050);
  });
});
