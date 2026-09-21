/**
 * Sep 21, 2026 — the 'team_lead' role: view-only visibility into the orders
 * of whichever MedReps are assigned to them (users.team_lead_id), the same
 * way orderScopeEndpoints.test.js proves scoped Management visibility.
 *
 * The distinction that matters here is the same one that file's own header
 * comment makes: a broken rule is loud (wrong count, empty table, somebody
 * complains); a route that simply never checks is silent — the dashboard
 * looks right and the only way to notice is somebody opening a URL, or
 * calling a write route directly, that they should never have reached. So
 * most of what follows asserts a 403 rather than a 200, on every write route
 * a Team Lead could reach — proving the read-only property holds even if the
 * frontend forgot to hide a button, not just that it does today.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = { users: [], orders: [] };

let adminToken;
let teamLeadToken;
let emptyTeamLeadToken;
let teamMedrepId; // on the team
let otherMedrepId; // not on the team
const planted = {};

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

async function makeUser(role, email, name, extra = {}) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const info = await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at, approval_status, team_lead_id)
       VALUES (?, ?, ?, ?, 1, ?, 'approved', ?)`
    )
    .run(name, email, seed.password_hash, role, new Date().toISOString(), extra.team_lead_id || null);
  created.users.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

async function plantOrder(key, medrepId, status = 'pending_management_approval') {
  const customer = await db.prepare('SELECT id FROM customers LIMIT 1').get();
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 100, 'Team Lead Test St', 'pending', ?, ?)`
    )
    .run(`GM-TEAMLEAD-${key}`, customer.id, medrepId, status, now, now);
  planted[key] = info.lastInsertRowid;
  created.orders.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

describe('team_lead role', () => {
  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');

    const teamLeadId = await makeUser('team_lead', 'scope.teamlead@getmeds.ph', 'Scope Team Lead');
    teamLeadToken = await loginAs('scope.teamlead@getmeds.ph');

    const emptyTeamLeadId = await makeUser('team_lead', 'scope.teamlead.empty@getmeds.ph', 'Scope Empty Team Lead');
    emptyTeamLeadToken = await loginAs('scope.teamlead.empty@getmeds.ph');

    teamMedrepId = await makeUser('medrep', 'scope.teamlead.rep@getmeds.ph', 'Scope Team Rep', { team_lead_id: teamLeadId });
    otherMedrepId = await makeUser('medrep', 'scope.teamlead.other@getmeds.ph', 'Scope Other Rep');

    await plantOrder('MINE', teamMedrepId);
    await plantOrder('OTHER', otherMedrepId);
    // Not visible to `emptyTeamLeadId` on purpose — used only by the
    // FAILS CLOSED assertions, which never expect to see it.
    void emptyTeamLeadId;
  });

  afterAll(async () => {
    for (const id of created.orders) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    // team_lead_id is a self-referencing FK — clear it on every created user
    // first, so a MedRep row referencing a Team Lead row does not block that
    // Team Lead's own deletion below, regardless of insertion order.
    for (const id of created.users) await db.prepare('UPDATE users SET team_lead_id = NULL WHERE id = ?').run(id);
    for (const id of created.users) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  const list = (token) => request(app).get('/api/management/orders?limit=5000').set('Authorization', `Bearer ${token}`);
  const summary = (token) => request(app).get('/api/management/summary').set('Authorization', `Bearer ${token}`);
  const detail = (token, orderId) => request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
  const idsIn = (res) => (res.body.data.orders || []).map((o) => o.getmeds_order_id);

  describe('GET /api/management/orders and /summary', () => {
    test('a Team Lead sees only their team\'s orders', async () => {
      const res = await list(teamLeadToken);
      expect(res.statusCode).toBe(200);
      const ids = idsIn(res);
      expect(ids).toContain('GM-TEAMLEAD-MINE');
      expect(ids).not.toContain('GM-TEAMLEAD-OTHER');
    });

    test('counts only what the Team Lead can see', async () => {
      const res = await summary(teamLeadToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.total_orders).toBeGreaterThanOrEqual(1);
      expect(res.body.data.scope.mode).toBe('team');
      expect(res.body.data.scope.team).toContain('Scope Team Rep');
    });

    test('FAILS CLOSED: a Team Lead with no assigned MedReps sees nothing', async () => {
      const res = await list(emptyTeamLeadToken);
      expect(res.statusCode).toBe(200);
      expect(idsIn(res)).toHaveLength(0);

      const sum = await summary(emptyTeamLeadToken);
      expect(sum.body.data.total_orders).toBe(0);
      expect(sum.body.data.scope.team).toEqual([]);
    });
  });

  describe('GET /api/orders/:id — the URL anyone can type', () => {
    test('a Team Lead can open an order raised by their own MedRep', async () => {
      const res = await detail(teamLeadToken, planted.MINE);
      expect(res.statusCode).toBe(200);
    });

    test('403 on an order raised by a MedRep not on their team', async () => {
      const res = await detail(teamLeadToken, planted.OTHER);
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('FAILS CLOSED: a Team Lead with no assigned MedReps is refused every order', async () => {
      const res = await detail(emptyTeamLeadToken, planted.MINE);
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * The property this whole role exists to guarantee: every write route,
   * called directly against an order that IS on the Team Lead's own team,
   * still refuses them. Proves the read-only property does not depend on
   * the frontend simply not offering the button.
   */
  describe('every write route refuses a Team Lead, even on their own team\'s order', () => {
    for (const action of ['approve', 'reject', 'send-back', 'resume']) {
      test(`POST /:id/${action} → 403`, async () => {
        const res = await request(app)
          .post(`/api/orders/${planted.MINE}/${action}`)
          .set('Authorization', `Bearer ${teamLeadToken}`)
          .send({ reason: 'test' });
        expect(res.statusCode).toBe(403);
      });
    }

    test('PATCH /:id/exception → 403', async () => {
      const res = await request(app)
        .patch(`/api/orders/${planted.MINE}/exception`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send({ reason: 'test' });
      expect(res.statusCode).toBe(403);
    });

    test('PATCH /:id/details → 403', async () => {
      const res = await request(app)
        .patch(`/api/orders/${planted.MINE}/details`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send({ delivery_notes: 'hijacked' });
      expect(res.statusCode).toBe(403);
    });

    test('PATCH /:id/items → 403', async () => {
      const res = await request(app)
        .patch(`/api/orders/${planted.MINE}/items`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send({ items: [] });
      expect(res.statusCode).toBe(403);
    });

    test('POST /:id/attachments → 403', async () => {
      const res = await request(app)
        .post(`/api/orders/${planted.MINE}/attachments`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send({ storagePath: 'x', file_type: 'other' });
      expect(res.statusCode).toBe(403);
    });

    test('POST /:id/attachments/:attachmentId/decide-delete → 403', async () => {
      const res = await request(app)
        .post(`/api/orders/${planted.MINE}/attachments/999999/decide-delete`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send({ approved: true });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('assigning a MedRep to a Team Lead (admin.controller.js update())', () => {
    test('admin reassigns a MedRep to a different Team Lead', async () => {
      const newLead = await makeUser('team_lead', 'scope.teamlead.new@getmeds.ph', 'Scope New Team Lead');
      const res = await request(app)
        .patch(`/api/admin/users/${otherMedrepId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ team_lead_id: newLead });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.team_lead_id).toBe(newLead);
    });

    test('admin unassigns a MedRep with team_lead_id: null', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${otherMedrepId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ team_lead_id: null });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.team_lead_id).toBeNull();
    });

    test('a nonexistent team_lead_id is rejected', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${otherMedrepId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ team_lead_id: 999999999 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TEAM_LEAD');
    });

    test('a user id that is not role=team_lead is rejected', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${otherMedrepId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ team_lead_id: teamMedrepId }); // a medrep, not a team_lead
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TEAM_LEAD');
    });
  });
});
