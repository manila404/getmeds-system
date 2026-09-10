/**
 * Sep 9, 2026 — GET /api/management/orders: pagination, date range, search.
 *
 * All three exist for the same reason. The Zoho import means this table is no
 * longer a few hundred rows the page could simply render — the live org has
 * 65,000+ Sales Orders — so "show me everything" stopped being a workable
 * answer and "find the one I want" stopped being something scrolling can do.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const seededOrderIds = [];
let adminToken;
let medrepToken;

/** Dates chosen to straddle a month boundary, so a range that excludes some is easy to express. */
const DATES = [
  '2026-07-10', '2026-07-20', '2026-08-01', '2026-08-15', '2026-08-31'
];

describe('Management orders list', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrep.body.data.token;

    const customer = await db.prepare("SELECT id FROM customers WHERE source = 'local' LIMIT 1").get();
    const rep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();

    // 30 orders, so the default 25-per-page actually has a second page to go to.
    for (let i = 0; i < 30; i++) {
      const date = DATES[i % DATES.length];
      const info = await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                               total_amount, delivery_address, zoho_sync_status, created_at, updated_at)
           VALUES (?, ?, ?, 'so_created', 'direct', ?, 'Paging Test St', 'pending', ?, ?)`
        )
        .run(
          `PAGE-TEST-${String(i).padStart(3, '0')}`,
          customer.id,
          rep.id,
          100 + i,
          `${date}T08:00:00.000Z`,
          `${date}T08:00:00.000Z`
        );
      seededOrderIds.push(info.lastInsertRowid);
    }
  });

  afterAll(async () => {
    for (const id of seededOrderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  const get = (qs = '') =>
    request(app).get(`/api/management/orders${qs}`).set('Authorization', `Bearer ${adminToken}`);

  describe('pagination', () => {
    test('defaults to 25 per page and reports the page count', async () => {
      const res = await get();

      expect(res.statusCode).toBe(200);
      expect(res.body.data.orders.length).toBeLessThanOrEqual(25);
      expect(res.body.data.pagination.limit).toBe(25);
      expect(res.body.data.pagination.page).toBe(1);
      expect(res.body.data.pagination.pages).toBe(
        Math.ceil(res.body.data.pagination.total / 25)
      );
    });

    test('page 2 returns different orders from page 1', async () => {
      const p1 = await get('?page=1&limit=25');
      const p2 = await get('?page=2&limit=25');

      const ids1 = p1.body.data.orders.map((o) => o.id);
      const ids2 = p2.body.data.orders.map((o) => o.id);

      expect(ids2.length).toBeGreaterThan(0);
      // No overlap: an off-by-one in the OFFSET would repeat a row across pages,
      // which reads as duplicate orders rather than as a paging bug.
      expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
    });

    test('a page past the end is empty rather than an error', async () => {
      const res = await get('?page=9999&limit=25');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.orders).toHaveLength(0);
    });

    test('an absurd limit is capped, not honoured', async () => {
      // Otherwise ?limit=999999 is the unbounded query the pagination exists to
      // prevent, just spelled differently.
      const res = await get('?limit=999999');
      expect(res.body.data.pagination.limit).toBe(5000);
    });

    test('a nonsense page or limit falls back to the defaults', async () => {
      const res = await get('?page=abc&limit=-4');
      expect(res.body.data.pagination.page).toBe(1);
      expect(res.body.data.pagination.limit).toBe(25);
    });
  });

  describe('date range', () => {
    const seededOnly = (orders) => orders.filter((o) => o.getmeds_order_id.startsWith('PAGE-TEST-'));

    test('date_from excludes everything before it', async () => {
      const res = await get('?date_from=2026-08-01&limit=5000');
      const mine = seededOnly(res.body.data.orders);

      expect(mine.length).toBeGreaterThan(0);
      for (const o of mine) expect(o.created_at >= '2026-08-01').toBe(true);
      // July orders were seeded, so this is a real exclusion and not a filter
      // that happens to match everything.
      expect(mine.length).toBeLessThan(30);
    });

    test('date_to includes the whole of its own day', async () => {
      // The bound that is easy to get wrong: an order stamped 08:00 on the
      // date picked must be INSIDE a range ending on that date. Comparing
      // against midnight would exclude it, so picking a single day would
      // return nothing.
      const res = await get('?date_from=2026-08-15&date_to=2026-08-15&limit=5000');
      const mine = seededOnly(res.body.data.orders);

      expect(mine.length).toBeGreaterThan(0);
      for (const o of mine) expect(o.created_at.slice(0, 10)).toBe('2026-08-15');
    });

    test('a range with nothing in it returns nothing, and says so in the count', async () => {
      const res = await get('?date_from=2020-01-01&date_to=2020-01-02&limit=5000');
      expect(res.body.data.orders).toHaveLength(0);
      expect(res.body.data.pagination.total).toBe(0);
      // pages is floored at 1 so the UI never renders "Page 1 of 0".
      expect(res.body.data.pagination.pages).toBe(1);
    });

    test('the total reflects the filter, not the whole table', async () => {
      const all = await get('?limit=1');
      const narrowed = await get('?date_from=2026-07-01&date_to=2026-07-31&limit=1');

      expect(narrowed.body.data.pagination.total).toBeGreaterThan(0);
      expect(narrowed.body.data.pagination.total).toBeLessThan(all.body.data.pagination.total);
    });
  });

  describe('search', () => {
    test('finds an order by its id', async () => {
      const res = await get('?search=PAGE-TEST-007');
      expect(res.body.data.orders).toHaveLength(1);
      expect(res.body.data.orders[0].getmeds_order_id).toBe('PAGE-TEST-007');
    });

    test('searching by customer name does not break the count query', async () => {
      // The count joins customers separately from the row query. When it did
      // not, any search touching c.name raised "missing FROM clause entry for
      // table c" — a 500 on the one thing the search box is for.
      const customer = await db.prepare("SELECT name FROM customers WHERE source = 'local' LIMIT 1").get();
      const res = await get(`?search=${encodeURIComponent(customer.name.slice(0, 6))}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.pagination.total).toBeGreaterThan(0);
    });
  });

  describe('assigned-MedRep filter', () => {
    test('filters to one rep, and the total follows the filter', async () => {
      // The only practical way to CHECK that an Order Ownership assignment
      // landed: ask for that rep's orders and look at them.
      const rep = await db.prepare("SELECT id FROM users WHERE LOWER(role)='medrep' LIMIT 1").get();
      const res = await get(`?medrep_id=${rep.id}&limit=5000`);

      expect(res.statusCode).toBe(200);
      for (const o of res.body.data.orders) expect(o.medrep_id).toBe(rep.id);
      expect(res.body.data.pagination.total).toBe(res.body.data.orders.length);
    });

    test('every row says which role owns it, so "assigned" can be told from "not yet"', async () => {
      const res = await get('?limit=5');
      for (const o of res.body.data.orders) expect(o.medrep_role).toBeTruthy();
    });

    test('unassigned=true returns only imported orders still held by an admin', async () => {
      const admin = await db.prepare("SELECT id FROM users WHERE LOWER(role)='admin' LIMIT 1").get();
      const customer = await db.prepare("SELECT id FROM customers LIMIT 1").get();
      const info = await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                               total_amount, delivery_address, zoho_sync_status, created_at, updated_at)
           VALUES ('ZOHO-UNASSIGNED-T1', ?, ?, 'so_created', 'direct', 10, 'x', 'synced', ?, ?)`
        )
        .run(customer.id, admin.id, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
      seededOrderIds.push(info.lastInsertRowid);

      const res = await get('?unassigned=true&limit=5000');
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.orders.map((o) => o.id);
      expect(ids).toContain(info.lastInsertRowid);
      // The seeded PAGE-TEST orders belong to a real medrep, so none of them
      // should be here — this filter is about what is still to be decided.
      for (const o of res.body.data.orders) {
        expect(o.getmeds_order_id.startsWith('ZOHO-')).toBe(true);
        expect((o.medrep_role || '').toLowerCase()).toBe('admin');
      }
    });
  });

  test('a MedRep cannot read the management orders list', async () => {
    const res = await request(app)
      .get('/api/management/orders')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.statusCode).toBe(403);
  });
});
