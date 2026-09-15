/**
 * Sep 15, 2026 — "Today" on the Dispatch page.
 *
 * Confirmed with the business: it applies to the two Recent lists, so
 * Dispatch sees all of today's orders to fulfill —
 *   New draft SOs          every draft SO created today
 *   Confirmed by Finance   every order Finance confirmed today, not shipped
 * in Philippine time, and not capped at 20.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}

describe('Dispatch: Today', () => {
  let token;
  let medrepId;
  let customerId;
  const created = [];
  const now = new Date();
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  const TWO_DAYS_AGO = hoursAgo(48);
  const JUST_NOW = hoursAgo(0);

  beforeAll(async () => {
    token = await loginAs('dispatch@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  async function orderAt(status, createdAt, { financeConfirmedAt = null } = {}) {
    const ref = `GM-TODAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, zoho_so_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'credit', 100, '1 Today St', ?, ?, ?)`
      )
      .run(ref, customerId, medrepId, status, `ZSO-${ref}`, createdAt, createdAt);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(id);
    if (financeConfirmedAt) {
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, created_at)
           VALUES (?, 'FINANCE_VERIFIED', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'Finance', ?)`
        )
        .run(id, financeConfirmedAt);
    }
    return id;
  }

  const recent = async (period) =>
    (await request(app).get('/api/dispatch/recent').query({ period }).set({ Authorization: `Bearer ${token}` })).body.data;

  test("today's draft SOs, and not older ones", async () => {
    const todays = await orderAt('ready_for_finance_verified', JUST_NOW);
    const older = await orderAt('ready_for_finance_verified', TWO_DAYS_AGO);
    const ids = (await recent('today')).new_draft_sos.map((o) => o.id);
    expect(ids).toContain(todays);
    expect(ids).not.toContain(older);
  });

  test('orders Finance confirmed today — even one raised days ago — and not ones confirmed before', async () => {
    const raisedEarlierConfirmedToday = await orderAt('ready_for_draft_invoice', TWO_DAYS_AGO, { financeConfirmedAt: JUST_NOW });
    const confirmedBefore = await orderAt('ready_for_dispatch', TWO_DAYS_AGO, { financeConfirmedAt: TWO_DAYS_AGO });
    const ids = (await recent('today')).finance_confirmed.map((o) => o.id);
    expect(ids).toContain(raisedEarlierConfirmedToday);
    expect(ids).not.toContain(confirmedBefore);

    // "Any time" still shows both.
    const all = (await recent(undefined)).finance_confirmed.map((o) => o.id);
    expect(all).toEqual(expect.arrayContaining([raisedEarlierConfirmedToday, confirmedBefore]));
  });

  test('today is not capped at 20', async () => {
    const ids = [];
    for (let i = 0; i < 22; i++) ids.push(await orderAt('ready_for_draft_invoice', JUST_NOW, { financeConfirmedAt: JUST_NOW }));
    const got = (await recent('today')).finance_confirmed.map((o) => o.id);
    expect(ids.every((id) => got.includes(id))).toBe(true);
  });
});
