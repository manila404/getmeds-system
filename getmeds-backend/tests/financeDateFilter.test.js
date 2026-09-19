/**
 * Sep 19, 2026 — two related fixes from the same confusion: a Finance user
 * comparing Zoho's own "Sales by Salesperson" report (today, org-wide,
 * invoices) against this app's "Completed" count (all-time, GetMeds-only,
 * delivered orders) and expecting the numbers to match. They never could —
 * different metrics entirely. The actual fix is giving Finance a real date
 * filter on THIS app's own numbers:
 *
 *   1. GET /api/finance/queue now takes date_from/date_to, filtered on
 *      o.updated_at, applied to the stage counts, the tab counts and the
 *      paged list (never to the "Needs your confirmation" panel, which
 *      deliberately ignores every filter — see finance.controller.js).
 *   2. GET /api/finance/my-confirmations — "each finance can see their
 *      approved/verified SO, filter it one day (today) and can select
 *      dates" — the signed-in Finance user's OWN confirmations, personal,
 *      not a roll-up across every Finance user.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/finance/queue?date_from=&date_to=', () => {
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

  async function makeOrder(status, { daysAgo = 0 } = {}) {
    const ref = `DATEFILT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address)
         VALUES (?, ?, ?, ?, 'direct', 2500, '1 Date St')`
      )
      .run(ref, customerId, medrepId, status)).lastInsertRowid;
    createdOrderIds.push(id);
    if (daysAgo) {
      const then = new Date(Date.now() - daysAgo * 86400000).toISOString();
      await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(then, id);
    }
    return id;
  }

  const today = () => new Date().toISOString().slice(0, 10);

  const queue = async (q = '') => {
    const res = await request(app).get(`/api/finance/queue${q}`).set(auth(financeToken));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('with no date params, an order updated long ago still counts (unchanged, all-time default)', async () => {
    const id = await makeOrder('completed', { daysAgo: 30 });
    const data = await queue('?stage=completed&origin=getmeds&limit=100');
    expect(data.orders.map((o) => o.id)).toContain(id);
    expect(data.date_from).toBeNull();
    expect(data.date_to).toBeNull();
  });

  test('filtered to today, an order last touched 30 days ago drops out of the stage count and the list', async () => {
    const oldId = await makeOrder('completed', { daysAgo: 30 });
    const freshId = await makeOrder('completed', { daysAgo: 0 });
    const t = today();
    const data = await queue(`?stage=completed&origin=getmeds&limit=100&date_from=${t}&date_to=${t}`);

    const ids = data.orders.map((o) => o.id);
    expect(ids).toContain(freshId);
    expect(ids).not.toContain(oldId);
    expect(data.date_from).toBe(t);
    expect(data.date_to).toBe(t);
  });

  test('the same filter narrows the stage card counts, not just the list', async () => {
    const t = today();
    const unfiltered = await queue('?origin=getmeds');
    const filtered = await queue(`?origin=getmeds&date_from=${t}&date_to=${t}`);
    // Thirty days of fixture orders sitting outside today can only shrink
    // the completed count, never grow it.
    expect(filtered.stats.completed).toBeLessThanOrEqual(unfiltered.stats.completed);
  });

  test('a malformed date is ignored rather than erroring', async () => {
    const data = await queue('?date_from=not-a-date&date_to=also-not-a-date');
    expect(data.date_from).toBeNull();
    expect(data.date_to).toBeNull();
  });

  test('the "Needs your confirmation" panel ignores the date filter, same as it ignores stage', async () => {
    const id = await makeOrder('ready_for_finance_verified', { daysAgo: 45 });
    const t = today();
    const data = await queue(`?date_from=${t}&date_to=${t}`);
    expect(data.recent.map((o) => o.id)).toContain(id);
  });
});

describe('GET /api/finance/my-confirmations', () => {
  let financeToken, financeTwoToken;
  let financeId, financeTwoId;
  let customerId, medrepId;
  const createdOrderIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    const finance = await db.prepare("SELECT id, password_hash FROM users WHERE email = 'finance@getmeds.ph'").get();
    financeId = finance.id;

    // A second Finance user, so "only mine" can be proved rather than assumed.
    const other = await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'finance')")
      .run('My Confirmations Other Finance', 'my-confirmations-other@getmeds.ph', finance.password_hash);
    financeTwoId = other.lastInsertRowid;
    financeTwoToken = await loginAs('my-confirmations-other@getmeds.ph');

    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(financeTwoId);
  });

  async function orderAwaitingFinance() {
    const ref = `MYCONF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_so_status)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 4200, '1 Confirm St', 'MOCK-SO', 'SO-TEST', 'draft')`
      )
      .run(ref, customerId, medrepId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    return id;
  }

  const confirm = async (token, orderId) => {
    jest.spyOn(zoho, 'confirmSalesOrder').mockResolvedValueOnce({ code: 0, message: 'ok' });
    const res = await request(app).post(`/api/finance/orders/${orderId}/verify`).set(auth(token)).send({ approved: true });
    expect(res.status).toBe(200);
  };

  const myConfirmations = async (token, q = '') => {
    const res = await request(app).get(`/api/finance/my-confirmations${q}`).set(auth(token));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('defaults to today, and only the signed-in Finance user\'s own confirmations', async () => {
    const mine = await orderAwaitingFinance();
    const theirs = await orderAwaitingFinance();
    await confirm(financeToken, mine);
    await confirm(financeTwoToken, theirs);

    const data = await myConfirmations(financeToken);
    const ids = data.orders.map((o) => o.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(data.date_from).toBe(data.date_to); // both default to today
    expect(data.summary.count).toBe(ids.length);
  });

  test('the summary totals the confirmed orders\' amounts', async () => {
    const id = await orderAwaitingFinance();
    await confirm(financeToken, id);
    const data = await myConfirmations(financeToken);
    const row = data.orders.find((o) => o.id === id);
    expect(row).toBeTruthy();
    expect(Number(row.total_amount)).toBe(4200);
    expect(data.summary.totalAmount).toBeGreaterThanOrEqual(4200);
  });

  test('a hold (not a confirm) never shows up here', async () => {
    const id = await orderAwaitingFinance();
    const res = await request(app)
      .post(`/api/finance/orders/${id}/verify`)
      .set(auth(financeToken))
      .send({ approved: false, reason: 'Overdue balance' });
    expect(res.status).toBe(200);

    const data = await myConfirmations(financeToken);
    expect(data.orders.map((o) => o.id)).not.toContain(id);
  });

  test('picking yesterday excludes a confirmation made today', async () => {
    const id = await orderAwaitingFinance();
    await confirm(financeToken, id);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const data = await myConfirmations(financeToken, `?date_from=${yesterday}&date_to=${yesterday}`);
    expect(data.orders.map((o) => o.id)).not.toContain(id);
  });

  test('paginates 25 per page — the summary total counts every page, not just the one shown', async () => {
    // Relative to whatever this suite already confirmed for financeToken
    // today (other tests above add a few) — 27 more guarantees at least a
    // second page regardless of run order.
    const before = (await myConfirmations(financeToken)).pagination.total;
    for (let i = 0; i < 27; i += 1) {
      const id = await orderAwaitingFinance();
      await confirm(financeToken, id);
    }
    const expectedTotal = before + 27;

    const page1 = await myConfirmations(financeToken, '?page=1');
    expect(page1.orders.length).toBe(25);
    expect(page1.pagination.page).toBe(1);
    expect(page1.pagination.limit).toBe(25);
    expect(page1.pagination.total).toBe(expectedTotal);
    expect(page1.summary.count).toBe(expectedTotal);

    const page2 = await myConfirmations(financeToken, '?page=2');
    expect(page2.orders.length).toBe(expectedTotal - 25);
    expect(page2.pagination.page).toBe(2);
    // No overlap between pages.
    const ids1 = new Set(page1.orders.map((o) => o.id));
    expect(page2.orders.every((o) => !ids1.has(o.id))).toBe(true);
  });
});
