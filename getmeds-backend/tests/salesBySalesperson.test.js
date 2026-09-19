/**
 * Sep 19, 2026 — "create a report tab so the finance can see these
 * details," a Sales by Salesperson report shaped after Zoho's own (order
 * count and order total, grouped by salesperson, for a date range, with a
 * Total row). Not a reproduction of Zoho's report column-for-column — this
 * app tracks neither invoices nor credit notes as their own records, only
 * `orders.total_amount` — see finance.controller.js's getSalesBySalesperson
 * for why.
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

describe('GET /api/finance/reports/sales-by-salesperson', () => {
  let financeToken;
  let customerId, medrepId;
  const createdOrderIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  async function makeOrder({ salesperson, amount, getmedsRef = true, daysAgo = 0 }) {
    const ref = getmedsRef
      ? `GM-SBS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      : `ZOHO-SBS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, salesperson)
         VALUES (?, ?, ?, 'completed', 'direct', ?, '1 Report St', ?)`
      )
      .run(ref, customerId, medrepId, amount, salesperson)).lastInsertRowid;
    createdOrderIds.push(id);
    if (daysAgo) {
      const then = new Date(Date.now() - daysAgo * 86400000).toISOString();
      await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(then, id);
    }
    return id;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const report = async (q = '') => {
    const res = await request(app).get(`/api/finance/reports/sales-by-salesperson${q}`).set(auth(financeToken));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('groups by salesperson, with a matching Total row, defaulting to today', async () => {
    await makeOrder({ salesperson: 'STC | KALAW', amount: 13359.90 });
    await makeOrder({ salesperson: 'STC | KALAW', amount: 6640.10 });
    const data = await report();

    expect(data.date_from).toBe(today());
    expect(data.date_to).toBe(today());
    const row = data.rows.find((r) => r.name === 'STC | KALAW');
    expect(row).toBeTruthy();
    expect(row.order_count).toBeGreaterThanOrEqual(2);
    expect(Number(row.order_total)).toBeGreaterThanOrEqual(20000);

    const sumCount = data.rows.reduce((s, r) => s + Number(r.order_count), 0);
    const sumTotal = data.rows.reduce((s, r) => s + Number(r.order_total), 0);
    expect(data.total.order_count).toBe(sumCount);
    expect(Number(data.total.order_total).toFixed(2)).toBe(sumTotal.toFixed(2));
  });

  test('an order with no salesperson is grouped as Unassigned, not dropped', async () => {
    await makeOrder({ salesperson: null, amount: 500 });
    const data = await report();
    expect(data.rows.some((r) => r.name === 'Unassigned')).toBe(true);
  });

  test('defaults to origin=all — an imported (ZOHO-) order counts unless narrowed', async () => {
    await makeOrder({ salesperson: 'IMPORT | TEST PERSON', amount: 1000, getmedsRef: false });
    const all = await report();
    const getmedsOnly = await report('?origin=getmeds');

    expect(all.rows.some((r) => r.name === 'IMPORT | TEST PERSON')).toBe(true);
    expect(getmedsOnly.rows.some((r) => r.name === 'IMPORT | TEST PERSON')).toBe(false);
  });

  test('an order outside the date range does not count', async () => {
    const old = await makeOrder({ salesperson: 'OLD | PERSON', amount: 999, daysAgo: 10 });
    const data = await report();
    expect(data.rows.some((r) => r.name === 'OLD | PERSON')).toBe(false);

    const t = today();
    const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const dataInRange = await report(`?date_from=${past}&date_to=${t}`);
    expect(dataInRange.rows.some((r) => r.name === 'OLD | PERSON')).toBe(true);
    void old;
  });

  test('paginates 25 salespersons per page — the Total row sums every group, not just the page shown', async () => {
    const before = await report();
    const stamp = Date.now();
    for (let i = 0; i < 26; i += 1) {
      await makeOrder({ salesperson: `PAGE-TEST-${stamp}-${i}`, amount: 100 });
    }
    const expectedGroups = before.pagination.total + 26;

    const page1 = await report('?page=1');
    expect(page1.rows.length).toBe(25);
    expect(page1.pagination).toEqual({ page: 1, limit: 25, total: expectedGroups, pages: Math.ceil(expectedGroups / 25) });
    // The grand total reflects EVERY order in range, not just the 25 groups on this page.
    expect(page1.total.order_count).toBe(before.total.order_count + 26);

    const page2 = await report('?page=2');
    expect(page2.rows.length).toBe(expectedGroups - 25);
    const names1 = new Set(page1.rows.map((r) => r.name));
    expect(page2.rows.every((r) => !names1.has(r.name))).toBe(true);
  });
});
