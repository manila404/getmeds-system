/**
 * Sep 11, 2026 — configuring who covers which divisions (Phase D).
 *
 * Phases A–C decide what a scope MEANS and enforce it. This is the screen that
 * sets one, and it has a failure mode the others do not: a permissions editor
 * reachable by the people it restricts is not a restriction.
 *
 * So the assertion this file exists for is that a division-scoped manager
 * gets 403 from every endpoint here — including when the thing they are
 * editing is themselves.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = { users: [] };
let adminToken;
let fullManagerToken;
let scopedManagerToken;
let scopedManagerId;
let targetManagerId;

async function makeManager({ email, name, orderScope }) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const info = await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at, order_scope, approval_status)
       VALUES (?, ?, ?, 'management', 1, ?, ?, 'approved')`
    )
    .run(name, email, seed.password_hash, new Date().toISOString(), orderScope);
  const id = info.lastInsertRowid;
  created.users.push(id);
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  return { id, token: res.body?.data?.token };
}

describe('manager scope administration', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;

    const full = await makeManager({ email: 'dscope.full@getmeds.ph', name: 'D Full', orderScope: 'all' });
    fullManagerToken = full.token;

    const scoped = await makeManager({ email: 'dscope.b2b@getmeds.ph', name: 'D B2B', orderScope: 'divisions' });
    scopedManagerToken = scoped.token;
    scopedManagerId = scoped.id;

    const target = await makeManager({ email: 'dscope.target@getmeds.ph', name: 'D Target', orderScope: 'all' });
    targetManagerId = target.id;
  });

  afterAll(async () => {
    for (const id of created.users) {
      await db.prepare('DELETE FROM manager_order_scope WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    if (db.close) await db.close();
  });

  const list = (token) => request(app).get('/api/manager-scopes').set('Authorization', `Bearer ${token}`);
  const set = (token, userId, body) =>
    request(app).put(`/api/manager-scopes/${userId}`).set('Authorization', `Bearer ${token}`).send(body);

  describe('who may use it', () => {
    test('an admin can', async () => {
      const res = await list(adminToken);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data.managers)).toBe(true);
    });

    test('a full-scope manager can — they hand out access', async () => {
      const res = await list(fullManagerToken);
      expect(res.statusCode).toBe(200);
    });

    test('a DIVISION-SCOPED manager cannot read it', async () => {
      const res = await list(scopedManagerToken);
      expect(res.statusCode).toBe(403);
    });

    test('a division-scoped manager cannot widen their OWN scope', async () => {
      // The one that makes the whole feature real. If this ever returns 200,
      // every other restriction in the system is advisory.
      const res = await set(scopedManagerToken, scopedManagerId, {
        order_scope: 'all',
        rules: []
      });
      expect(res.statusCode).toBe(403);

      const after = await db.prepare('SELECT order_scope FROM users WHERE id = ?').get(scopedManagerId);
      expect(after.order_scope).toBe('divisions');
    });

    test('a division-scoped manager cannot widen someone else’s either', async () => {
      const res = await set(scopedManagerToken, targetManagerId, { order_scope: 'all', rules: [] });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('setting a scope', () => {
    test('assigns divisions and reports them back', async () => {
      const res = await set(adminToken, targetManagerId, {
        order_scope: 'divisions',
        rules: [{ division: 'B2B' }, { division: 'CLIDP' }]
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.order_scope).toBe('divisions');
      expect(res.body.data.rules.map((r) => r.division).sort()).toEqual(['B2B', 'CLIDP']);
      expect(res.body.data.warning).toBeNull();
    });

    test('REPLACES the rule set rather than merging into it', async () => {
      // Merge semantics would mean the screen and the database can disagree
      // about what was intended, and with permissions the ambiguous case is
      // the dangerous one — a division nobody meant to grant, still granted.
      await set(adminToken, targetManagerId, {
        order_scope: 'divisions',
        rules: [{ division: 'HOS' }]
      });
      const rows = await db
        .prepare('SELECT division FROM manager_order_scope WHERE user_id = ?')
        .all(targetManagerId);
      expect(rows.map((r) => r.division)).toEqual(['HOS']);
    });

    test('accepts a sub-division rule', async () => {
      const res = await set(adminToken, targetManagerId, {
        order_scope: 'divisions',
        rules: [{ division: 'B2B', sub_division: 'NBD' }]
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.rules[0].sub_division).toBe('NBD');
    });

    test('tolerates a duplicate rule instead of erroring on the unique index', async () => {
      // A double-click, not a conflict worth an error page.
      const res = await set(adminToken, targetManagerId, {
        order_scope: 'divisions',
        rules: [{ division: 'B2B' }, { division: 'B2B' }]
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.rules).toHaveLength(1);
    });

    test('warns when a manager is restricted to nothing', async () => {
      // Deliberate behaviour, but it should never be a surprise: this manager
      // will open the dashboard and see zero orders.
      const res = await set(adminToken, targetManagerId, { order_scope: 'divisions', rules: [] });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.warning).toMatch(/no orders at all/i);
    });

    test('switching back to full access clears the rules', async () => {
      await set(adminToken, targetManagerId, { order_scope: 'divisions', rules: [{ division: 'HOS' }] });
      const res = await set(adminToken, targetManagerId, { order_scope: 'all', rules: [] });
      expect(res.statusCode).toBe(200);
      const rows = await db
        .prepare('SELECT division FROM manager_order_scope WHERE user_id = ?')
        .all(targetManagerId);
      expect(rows).toHaveLength(0);
    });

    test('rejects a division that is not on the list', async () => {
      const res = await set(adminToken, targetManagerId, {
        order_scope: 'divisions',
        rules: [{ division: 'NOT_A_DIVISION' }]
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('refuses to scope a non-management user', async () => {
      const rep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
      const res = await set(adminToken, rep.id, { order_scope: 'divisions', rules: [{ division: 'B2B' }] });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toMatch(/management users only/i);
    });

    test('404 for a user that does not exist', async () => {
      const res = await set(adminToken, 99999999, { order_scope: 'all', rules: [] });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('what the list tells you', () => {
    test('shows order counts per division, so a rule’s worth is visible', async () => {
      // URO holds 6 orders and B2B holds ~8,900. Assigning one of those is not
      // the same decision as assigning the other, and the screen should not
      // make them look alike.
      const res = await list(adminToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.orders_by_division).toBeDefined();
      expect(res.body.data.divisions).toEqual(expect.arrayContaining(['B2B', 'HOS', 'CLIDP']));
    });

    test('names the unattributable orders rather than hiding them', async () => {
      // The largest single bucket, and the reason a scoped manager's totals
      // will never add up to the whole system.
      const res = await list(adminToken);
      expect(typeof res.body.data.unattributed_orders).toBe('number');
    });

    test('reports the scope a manager actually has right now', async () => {
      const res = await list(adminToken);
      const scoped = res.body.data.managers.find((m) => m.id === scopedManagerId);
      expect(scoped.order_scope).toBe('divisions');
      expect(scoped.scope_explicit).toBe(true);
    });
  });
});
