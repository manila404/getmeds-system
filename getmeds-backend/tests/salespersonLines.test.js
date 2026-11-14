/**
 * Nov 14, 2026 (Aaron): a salesperson's order has one line per medicine and no ₱0 price (free goods
 * come only from a Buy 1 Take 1 promo). Management is not limited.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { isSalespersonRole, salespersonLineProblem } = require('../src/services/orderLineRules');

const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'demo123' })).body.data.token;
const as = (t) => ({ Authorization: `Bearer ${t}` });
const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

describe('salespersonLineProblem (the rule)', () => {
  const line = (product_id, unit_price) => ({ product_id, unit_price, name: `P${product_id}` });

  test('only MedReps and Team Leads are checked', () => {
    expect(['medrep', 'TEAM_LEAD'].map(isSalespersonRole)).toEqual([true, true]);
    expect(['management', 'admin', 'finance', undefined].map(isSalespersonRole)).toEqual([false, false, false, false]);
  });

  test('different medicines at a price are fine', () => {
    expect(salespersonLineProblem([line(1, 35), line(2, 10)])).toBeNull();
  });

  test('the same medicine twice is refused', () => {
    expect(salespersonLineProblem([line(1, 35), line(1, 30)])).toMatch(/P1 is on the order more than once/);
  });

  test('a ₱0 price is refused, unless it is the promo free line next to a paid line', () => {
    expect(salespersonLineProblem([line(1, 0)])).toMatch(/cannot be ₱0/);
    expect(salespersonLineProblem([line(1, 35), line(1, 0)])).toMatch(/cannot be ₱0/);
    expect(salespersonLineProblem([line(1, 35), line(1, 0)], new Set([1]))).toBeNull();
    expect(salespersonLineProblem([line(1, 0)], new Set([1]))).toMatch(/cannot be ₱0/);
    expect(salespersonLineProblem([line(1, 35), line(1, 0), line(1, 0)], new Set([1]))).toMatch(/cannot be ₱0/);
  });
});

describe('creating an order', () => {
  let medrepToken, managerToken, productId, customerId;
  const orderIds = [];
  const savedTestIds = process.env.ZOHO_TEST_CUSTOMER_IDS;
  const savedTestId = process.env.ZOHO_TEST_CUSTOMER_ID;
  beforeAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = '';
    process.env.ZOHO_TEST_CUSTOMER_ID = '';
    medrepToken = await login('medrep@getmeds.ph');
    managerToken = await login('manager@getmeds.ph');
    await db.prepare('INSERT INTO products (name, sku, unit_price, stock, is_active) VALUES (?, ?, 35, 500, 1)').run(`Line Med ${stamp}`, `LINE-${stamp}`);
    productId = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(`LINE-${stamp}`)).id;
    await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Line Customer ${stamp}`, `LC-${stamp}`);
    customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Line Customer ${stamp}`)).id;
  });
  afterAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = savedTestIds || '';
    process.env.ZOHO_TEST_CUSTOMER_ID = savedTestId || '';
    for (const id of orderIds) {
      for (const t of ['order_items', 'order_events', 'notifications', 'zoho_sync_queue']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });
  const create = (token, items) => request(app).post('/api/orders').set(as(token)).send({
    customer_id: customerId, status: 'draft', delivery_address: '1 Line St', items
  });

  test('a MedRep cannot send the same medicine twice', async () => {
    const res = await create(medrepToken, [{ product_id: productId, quantity: 2, rate: 35 }, { product_id: productId, quantity: 1, rate: 35 }]);
    expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_LINE']);
  });

  test('a MedRep cannot price a line at ₱0', async () => {
    const res = await create(medrepToken, [{ product_id: productId, quantity: 2, rate: 0 }]);
    expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_LINE']);
  });

  test('Management still can', async () => {
    const res = await create(managerToken, [{ product_id: productId, quantity: 2, rate: 0 }]);
    expect([res.status, res.body?.error?.message]).toEqual([201, undefined]);
    orderIds.push(res.body.data.order.id);
  });
});
