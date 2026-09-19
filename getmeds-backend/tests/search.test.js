/**
 * Sep 19, 2026 — the top-nav search bar ("Search orders, clients,
 * products..."), wired up for the first time. It had no handler, no state
 * and no backend endpoint behind it at all before this — confirmed by
 * reading Topbar.jsx before writing any of this.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/search', () => {
  let medrepToken, otherRepToken, financeToken;
  let medrepId, otherRepId;
  let customerId, productId;
  const createdOrderIds = [];
  const createdUserIds = [];

  beforeAll(async () => {
    medrepToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
    const medrep = await db.prepare("SELECT id, password_hash FROM users WHERE email = 'medrep@getmeds.ph'").get();
    medrepId = medrep.id;

    const other = await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'medrep')")
      .run('Search Other Rep', 'search-other-rep@getmeds.ph', medrep.password_hash);
    otherRepId = other.lastInsertRowid;
    createdUserIds.push(otherRepId);
    otherRepToken = await loginAs('search-other-rep@getmeds.ph');

    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    productId = (await db.prepare('SELECT id FROM products LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  const search = async (q, token = medrepToken) => {
    const res = await request(app).get('/api/search').set(auth(token)).query({ q });
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('a query under 2 characters returns nothing, rather than a huge unfiltered scan', async () => {
    const data = await search('a');
    expect(data.orders).toEqual([]);
    expect(data.customers).toEqual([]);
    expect(data.products).toEqual([]);
  });

  test('finds an order by its GM order id', async () => {
    const ref = `GM-SEARCH-${Date.now()}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 1000, '1 Search St')`
      )
      .run(ref, customerId, medrepId)).lastInsertRowid;
    createdOrderIds.push(id);

    const data = await search(ref.slice(-8));
    expect(data.orders.some((o) => o.id === id)).toBe(true);
  });

  test('a MedRep only finds their own orders, not a colleague\'s', async () => {
    const ref = `GM-SEARCHSCOPE-${Date.now()}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 1000, '1 Search St')`
      )
      .run(ref, customerId, otherRepId)).lastInsertRowid;
    createdOrderIds.push(id);

    const mine = await search(ref.slice(-8), medrepToken);
    expect(mine.orders.some((o) => o.id === id)).toBe(false);

    const financeView = await search(ref.slice(-8), financeToken);
    expect(financeView.orders.some((o) => o.id === id)).toBe(true);
  });

  test('finds a customer by name', async () => {
    const customer = await db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
    const fragment = customer.name.slice(0, Math.min(6, customer.name.length));
    const data = await search(fragment);
    expect(data.customers.some((c) => c.id === customerId)).toBe(true);
  });

  test('finds a product by name', async () => {
    const product = await db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    const fragment = product.name.slice(0, Math.min(6, product.name.length));
    const data = await search(fragment);
    expect(data.products.some((p) => p.id === productId)).toBe(true);
  });

  test('a literal % or _ in the query is matched literally, not as a wildcard', async () => {
    // Would otherwise match everything (a bare '%' matches any string).
    const data = await search('%');
    expect(data.orders).toEqual([]);
    expect(data.customers).toEqual([]);
    expect(data.products).toEqual([]);
  });
});
