/**
 * Sep 11, 2026 — scoped manager visibility, end to end (Phase B).
 *
 * orderScope.test.js covers the rules in isolation. This file covers the thing
 * that actually protects anyone: whether the rules are APPLIED, on every
 * surface, every time.
 *
 * The distinction matters because the two failure modes look nothing alike. A
 * broken rule is loud — the wrong count, an empty table, somebody complains.
 * A rule that is simply never consulted on one endpoint is silent: the list is
 * filtered, the dashboard looks right, and the only way to notice is for
 * somebody to open a URL they should not have been able to open.
 *
 * So most of what follows asserts a 403 rather than a 200.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = { users: [], orders: [], scopes: [] };

let adminToken;
let fullManagerToken;
let b2bManagerToken;
let emptyManagerToken;

/** Orders planted in known divisions, so "can this person see it" has a fixed answer. */
const planted = {};

async function makeManager({ email, name, orderScope, rules = [] }) {
  // bcrypt hash of 'demo123', the password every seeded account uses.
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const info = await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at, order_scope, approval_status)
       VALUES (?, ?, ?, 'management', 1, ?, ?, 'approved')`
    )
    .run(name, email, seed.password_hash, new Date().toISOString(), orderScope);

  const userId = info.lastInsertRowid;
  created.users.push(userId);

  for (const r of rules) {
    const row = await db
      .prepare(
        `INSERT INTO manager_order_scope (user_id, division, sub_division, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(userId, r.division, r.sub_division || null, new Date().toISOString());
    created.scopes.push(row.lastInsertRowid);
  }

  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  return res.body?.data?.token;
}

async function plantOrder(key, division, status = 'pending_management_approval') {
  const customer = await db.prepare("SELECT id FROM customers LIMIT 1").get();
  const rep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, division, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 100, 'Scope Test St', 'pending', ?, ?, ?)`
    )
    .run(`GM-SCOPE-${key}`, customer.id, rep.id, status, division, now, now);
  planted[key] = info.lastInsertRowid;
  created.orders.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

describe('scoped manager visibility — endpoints', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;

    fullManagerToken = await makeManager({
      email: 'scope.full@getmeds.ph', name: 'Scope Full', orderScope: 'all'
    });
    b2bManagerToken = await makeManager({
      email: 'scope.b2b@getmeds.ph', name: 'Scope B2B', orderScope: 'divisions',
      rules: [{ division: 'B2B' }, { division: 'CLIDP' }]
    });
    // Configured to be scoped, but nobody gave them any divisions.
    emptyManagerToken = await makeManager({
      email: 'scope.empty@getmeds.ph', name: 'Scope Empty', orderScope: 'divisions'
    });

    await plantOrder('B2B', 'B2B');
    await plantOrder('CLIDP', 'CLIDP');
    await plantOrder('HOS', 'HOS');
    await plantOrder('NULLDIV', null);
    // A HOS order sitting in the FINANCE queue specifically. The four above
    // are at pending_management_approval, which that queue correctly excludes,
    // so they cannot show whether the queue is scoped or merely empty.
    await plantOrder('HOSFIN', 'HOS', 'ready_for_finance_verified');
  });

  afterAll(async () => {
    for (const id of created.orders) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of created.scopes) await db.prepare('DELETE FROM manager_order_scope WHERE id = ?').run(id);
    for (const id of created.users) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (db.close) await db.close();
  });

  const list = (token, qs = '') =>
    request(app).get(`/api/management/orders?limit=5000${qs}`).set('Authorization', `Bearer ${token}`);

  const detail = (token, orderId) =>
    request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);

  const idsIn = (res) => (res.body.data.orders || []).map((o) => o.getmeds_order_id);

  describe('GET /api/management/orders', () => {
    test('a full-scope manager sees every division', async () => {
      const res = await list(fullManagerToken);
      expect(res.statusCode).toBe(200);
      const ids = idsIn(res);
      expect(ids).toEqual(expect.arrayContaining([
        'GM-SCOPE-B2B', 'GM-SCOPE-CLIDP', 'GM-SCOPE-HOS', 'GM-SCOPE-NULLDIV'
      ]));
    });

    test('a scoped manager sees their divisions and NOT the others', async () => {
      const res = await list(b2bManagerToken);
      expect(res.statusCode).toBe(200);
      const ids = idsIn(res);

      expect(ids).toEqual(expect.arrayContaining(['GM-SCOPE-B2B', 'GM-SCOPE-CLIDP']));
      // The assertion this file exists for.
      expect(ids).not.toContain('GM-SCOPE-HOS');
    });

    test('an order with no division is invisible to a scoped manager', async () => {
      // Half the imported history is in this state: Zoho recorded no
      // salesperson, so no division can be attributed. Those orders belong to
      // the full-scope manager alone rather than being shown to everyone.
      const ids = idsIn(await list(b2bManagerToken));
      expect(ids).not.toContain('GM-SCOPE-NULLDIV');

      const fullIds = idsIn(await list(fullManagerToken));
      expect(fullIds).toContain('GM-SCOPE-NULLDIV');
    });

    test('FAILS CLOSED: a scoped manager with no rules sees nothing', async () => {
      const res = await list(emptyManagerToken);
      expect(res.statusCode).toBe(200);
      expect(idsIn(res)).toHaveLength(0);
      expect(res.body.data.pagination.total).toBe(0);
    });

    test('a query-string filter cannot widen the scope', async () => {
      // The scope clause is pushed onto the same WHERE list as the filters, so
      // every filter narrows what is already narrowed. If scope were appended
      // some other way, a crafted filter might displace it.
      const ids = idsIn(await list(b2bManagerToken, '&status=pending_management_approval'));
      expect(ids).not.toContain('GM-SCOPE-HOS');
      expect(ids).not.toContain('GM-SCOPE-NULLDIV');
    });

    test('the page total matches what the viewer can actually see', async () => {
      // A total counted over a wider set than the rows is how a scoped list
      // still leaks: "1 of 60,866" tells you plenty you should not know.
      const scoped = await list(b2bManagerToken);
      const full = await list(fullManagerToken);
      expect(scoped.body.data.pagination.total).toBeLessThan(full.body.data.pagination.total);
      expect(scoped.body.data.pagination.total).toBeGreaterThan(0);
    });
  });

  describe('GET /api/orders/:id — the URL anyone can type', () => {
    test('a scoped manager can open an order in their divisions', async () => {
      const res = await detail(b2bManagerToken, planted.B2B);
      expect(res.statusCode).toBe(200);
    });

    test('403 on an order outside their divisions', async () => {
      // Filtering the list and stopping there would leave this at 200.
      const res = await detail(b2bManagerToken, planted.HOS);
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('403 on an order with no division', async () => {
      const res = await detail(b2bManagerToken, planted.NULLDIV);
      expect(res.statusCode).toBe(403);
    });

    test('FAILS CLOSED: a manager with no rules is refused every order', async () => {
      for (const key of ['B2B', 'CLIDP', 'HOS', 'NULLDIV']) {
        const res = await detail(emptyManagerToken, planted[key]);
        expect(res.statusCode).toBe(403);
      }
    });

    test('a full-scope manager and an admin can open anything', async () => {
      for (const token of [fullManagerToken, adminToken]) {
        for (const key of ['B2B', 'HOS', 'NULLDIV']) {
          const res = await detail(token, planted[key]);
          expect(res.statusCode).toBe(200);
        }
      }
    });
  });

  describe('GET /api/management/summary', () => {
    const summary = (token) =>
      request(app).get('/api/management/summary').set('Authorization', `Bearer ${token}`);

    test('counts only what the viewer can see', async () => {
      const scoped = await summary(b2bManagerToken);
      const full = await summary(fullManagerToken);
      expect(scoped.statusCode).toBe(200);
      expect(scoped.body.data.total_orders).toBeLessThan(full.body.data.total_orders);
    });

    test('FAILS CLOSED: a manager with no rules sees zeroes, not totals', async () => {
      const res = await summary(emptyManagerToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.total_orders).toBe(0);
      expect(res.body.data.completed_count).toBe(0);
      expect(res.body.data.orders_by_status).toEqual({});
    });

    test('says what it is counting, so a narrow view is legible', async () => {
      const res = await summary(b2bManagerToken);
      expect(res.body.data.scope.mode).toBe('divisions');
      expect(res.body.data.scope.divisions).toEqual(expect.arrayContaining(['B2B', 'CLIDP']));

      const full = await summary(fullManagerToken);
      expect(full.body.data.scope.mode).toBe('all');
    });
  });

  /**
   * Phase C. The read tests above are about what somebody can SEE; these are
   * about what they can DO, and that is the difference that matters. A gap in
   * the list means a manager glimpsed an order in another division. A gap here
   * means they APPROVED it — the order moves on through Zoho with their name
   * on it, and nothing about the screen suggested they should not have.
   */
  describe('actions — approve / reject / send back', () => {
    const act = (token, orderId, action, body = {}) =>
      request(app)
        .post(`/api/orders/${orderId}/${action}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    for (const action of ['approve', 'reject', 'send-back']) {
      test(`${action}: 403 on an order outside the manager's divisions`, async () => {
        const res = await act(b2bManagerToken, planted.HOS, action, { reason: 'test' });
        expect(res.statusCode).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });

      test(`${action}: 403 on an order with no division`, async () => {
        const res = await act(b2bManagerToken, planted.NULLDIV, action, { reason: 'test' });
        expect(res.statusCode).toBe(403);
      });

      test(`${action}: FAILS CLOSED for a manager with no rules`, async () => {
        const res = await act(emptyManagerToken, planted.B2B, action, { reason: 'test' });
        expect(res.statusCode).toBe(403);
      });
    }

    test('a scoped manager CAN act within their own divisions', async () => {
      // The control. Without this the 403s above could all be passing because
      // the token is broken rather than because scope is enforced.
      const res = await act(b2bManagerToken, planted.CLIDP, 'send-back', { reason: 'needs detail' });
      expect(res.statusCode).not.toBe(403);
    });

    test('setException is guarded too', async () => {
      // Not approve/reject/send-back, but management-gated and order-specific.
      // It is covered because the guard hangs off the `:id` parameter rather
      // than being listed per route — which is the whole point of putting it
      // there.
      const res = await request(app)
        .patch(`/api/orders/${planted.HOS}/exception`)
        .set('Authorization', `Bearer ${b2bManagerToken}`)
        .send({ reason: 'test' });
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * Finance's per-order routes are open to `management`, so they are a second
   * door into the same orders. Found by reading the route table rather than by
   * anything failing — which is how this kind of gap is normally found, and
   * why it is worth a test.
   */
  describe('finance routes are a second door into the same orders', () => {
    test('a scoped manager cannot verify payment outside their divisions', async () => {
      const res = await request(app)
        .post(`/api/finance/orders/${planted.HOS}/verify`)
        .set('Authorization', `Bearer ${b2bManagerToken}`)
        .send({});
      expect(res.statusCode).toBe(403);
    });

    test('a scoped manager cannot read payment detail outside their divisions', async () => {
      const res = await request(app)
        .get(`/api/finance/orders/${planted.HOS}/payment`)
        .set('Authorization', `Bearer ${b2bManagerToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('the finance queue is narrowed for a scoped manager', async () => {
      const scoped = await request(app)
        .get('/api/finance/queue')
        .set('Authorization', `Bearer ${b2bManagerToken}`);
      expect(scoped.statusCode).toBe(200);
      const ids = (scoped.body.data.orders || []).map((o) => o.getmeds_order_id);
      expect(ids).not.toContain('GM-SCOPE-HOSFIN');
    });

    test('Finance’s own queue is untouched', async () => {
      // Scoping must narrow the MANAGEMENT view of this page without taking
      // orders out of the queue the Finance team actually works from.
      const fin = await request(app).post('/api/auth/login').send({ email: 'finance@getmeds.ph', password: 'demo123' });
      const token = fin.body?.data?.token;
      if (!token) return; // no seeded finance account in this database
      const res = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toBe(200);
      const ids = (res.body.data.orders || []).map((o) => o.getmeds_order_id);
      expect(ids).toEqual(expect.arrayContaining(['GM-SCOPE-HOSFIN']));
    });
  });
});
