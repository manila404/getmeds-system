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
let teamLeadId;
let teamMedrepId; // on the team
let otherMedrepId; // not on the team
const planted = {};

/**
 * Sep 24, 2026: the Zoho test-customer gate is switched off for this file.
 *
 * While ZOHO_TEST_CUSTOMER_IDS is set (it is, in this project's .env), submit()
 * refuses every customer that isn't a designated test customer — for EVERY
 * role, with a 403 TEST_CUSTOMER_ONLY. That is a Zoho safety gate, not a
 * permission rule, but from a test's side a 403 is a 403: it once made a Team
 * Lead's submit look like a permissions bug when the response was really the
 * gate refusing a fixture customer. A test about who may submit has to take
 * the gate out of the picture (orderAsMedrep.test.js and
 * orderIdSequence.test.js do the same); the originals are restored after.
 */
const savedGateEnv = {
  ids: process.env.ZOHO_TEST_CUSTOMER_IDS,
  id: process.env.ZOHO_TEST_CUSTOMER_ID
};
const restoreEnv = (key, value) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
async function pickCustomerId() {
  return (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
}

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

async function plantOrder(key, medrepId, status = 'pending_management_approval', raisedById = null) {
  const customerId = await pickCustomerId();
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type,
                           total_amount, delivery_address, delivery_notes, zoho_sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'direct', 100, 'Team Lead Test St', 'original', 'pending', ?, ?)`
    )
    .run(`GM-TEAMLEAD-${key}`, customerId, medrepId, raisedById, status, now, now);
  planted[key] = info.lastInsertRowid;
  created.orders.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

describe('team_lead role', () => {
  beforeAll(async () => {
    delete process.env.ZOHO_TEST_CUSTOMER_IDS;
    delete process.env.ZOHO_TEST_CUSTOMER_ID;
    adminToken = await loginAs('admin@getmeds.ph');

    teamLeadId = await makeUser('team_lead', 'scope.teamlead@getmeds.ph', 'Scope Team Lead');
    teamLeadToken = await loginAs('scope.teamlead@getmeds.ph');

    const emptyTeamLeadId = await makeUser('team_lead', 'scope.teamlead.empty@getmeds.ph', 'Scope Empty Team Lead');
    emptyTeamLeadToken = await loginAs('scope.teamlead.empty@getmeds.ph');

    teamMedrepId = await makeUser('medrep', 'scope.teamlead.rep@getmeds.ph', 'Scope Team Rep', { team_lead_id: teamLeadId });
    otherMedrepId = await makeUser('medrep', 'scope.teamlead.other@getmeds.ph', 'Scope Other Rep');

    await plantOrder('MINE', teamMedrepId);
    await plantOrder('OTHER', otherMedrepId);
    // Sep 24, 2026: three drafts, one per relationship a Team Lead can have to
    // an order — see the "acts only on orders that are theirs" block below.
    await plantOrder('TEAMMATE_DRAFT', teamMedrepId, 'draft'); // a teammate's, not raised by the lead
    await plantOrder('RAISED', teamMedrepId, 'draft', teamLeadId); // the lead raised it FOR the teammate
    await plantOrder('OWN', teamLeadId, 'draft'); // the lead's own (medrep_id is them, raised_by_id NULL)
    await plantOrder('OTHER_DRAFT', otherMedrepId, 'draft'); // outside the team entirely
    // Not visible to `emptyTeamLeadId` on purpose — used only by the
    // FAILS CLOSED assertions, which never expect to see it.
    void emptyTeamLeadId;
  });

  afterAll(async () => {
    restoreEnv('ZOHO_TEST_CUSTOMER_IDS', savedGateEnv.ids);
    restoreEnv('ZOHO_TEST_CUSTOMER_ID', savedGateEnv.id);
    // Submitting an order notifies Management; those rows point at an order
    // that's about to stop existing.
    for (const id of created.orders) await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
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

    // Sep 24, 2026: orders the lead raised or owns are in their scope too, not
    // only a teammate's — see teamScopeService.js.
    test("a Team Lead's own orders are in their list too", async () => {
      const ids = idsIn(await list(teamLeadToken));
      expect(ids).toContain('GM-TEAMLEAD-OWN');
      expect(ids).toContain('GM-TEAMLEAD-RAISED');
      expect(ids).not.toContain('GM-TEAMLEAD-OTHER_DRAFT');
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

  /**
   * Sep 24, 2026 — the rule, stated both ways. A Team Lead can SEE every order
   * their team raised, but can CHANGE only an order that is theirs: one they
   * raised (raised_by_id), or one that is theirs outright (medrep_id).
   *
   * The Sep 22 version of canEditOrder let a Team Lead edit any in-team order
   * that hadn't reached Zoho, which the old blanket "PATCH /details → 403"
   * test above caught as a failure — a test the change had left behind, but
   * also a real gap. These assert the narrower rule the change should have
   * shipped with, from both sides, so neither over-blocking (a lead who can't
   * finish what they created) nor under-blocking (a lead rewriting a
   * teammate's order) can come back unnoticed.
   *
   * Statuses to read: 400/409 on the "theirs" cases are the route getting PAST
   * the permission check and stopping on a precondition (empty item list, no
   * Sales Order yet, nothing failed to retry) — what proves it isn't a 403.
   */
  describe('a Team Lead acts only on orders that are theirs', () => {
    const asLead = (method, orderKey, suffix, body = {}) =>
      request(app)[method](`/api/orders/${planted[orderKey]}${suffix}`)
        .set('Authorization', `Bearer ${teamLeadToken}`)
        .send(body);

    describe("a teammate's order (visible to them, not theirs) is refused", () => {
      test('PATCH /details → 403, and nothing changes', async () => {
        const res = await asLead('patch', 'TEAMMATE_DRAFT', '/details', { delivery_notes: 'hijacked' });
        expect(res.statusCode).toBe(403);
        const row = await db.prepare('SELECT delivery_notes FROM orders WHERE id = ?').get(planted.TEAMMATE_DRAFT);
        expect(row.delivery_notes).toBe('original');
      });

      test('PATCH /items → 403', async () => {
        const res = await asLead('patch', 'TEAMMATE_DRAFT', '/items', { items: [] });
        expect(res.statusCode).toBe(403);
      });

      test('POST /submit → 403', async () => {
        const res = await asLead('post', 'TEAMMATE_DRAFT', '/submit');
        expect(res.statusCode).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });

      test('POST /sync-from-zoho → 403', async () => {
        const res = await asLead('post', 'TEAMMATE_DRAFT', '/sync-from-zoho');
        expect(res.statusCode).toBe(403);
      });

      test('POST /retry-zoho-sync → 403 (it would create a real Sales Order)', async () => {
        const res = await asLead('post', 'TEAMMATE_DRAFT', '/retry-zoho-sync');
        expect(res.statusCode).toBe(403);
      });
    });

    describe('an order outside their team is refused too', () => {
      test('PATCH /details, POST /submit, POST /sync-from-zoho → 403', async () => {
        expect((await asLead('patch', 'OTHER_DRAFT', '/details', { delivery_notes: 'x' })).statusCode).toBe(403);
        expect((await asLead('post', 'OTHER_DRAFT', '/submit')).statusCode).toBe(403);
        expect((await asLead('post', 'OTHER_DRAFT', '/sync-from-zoho')).statusCode).toBe(403);
      });
    });

    describe('an order they raised for a teammate is theirs to work', () => {
      test('PATCH /details → 200, and the edit lands', async () => {
        const res = await asLead('patch', 'RAISED', '/details', { delivery_notes: 'fixed by the lead' });
        expect(res.statusCode).toBe(200);
        const row = await db.prepare('SELECT delivery_notes FROM orders WHERE id = ?').get(planted.RAISED);
        expect(row.delivery_notes).toBe('fixed by the lead');
      });

      test('PATCH /items gets past the permission check (400: no items sent)', async () => {
        const res = await asLead('patch', 'RAISED', '/items', { items: [] });
        expect(res.statusCode).toBe(400);
      });

      test('POST /sync-from-zoho gets past the permission check (400: no Sales Order yet)', async () => {
        const res = await asLead('post', 'RAISED', '/sync-from-zoho');
        expect(res.statusCode).toBe(400);
        expect(res.body.error.code).toBe('NO_ZOHO_SO');
      });

      test('POST /retry-zoho-sync gets past the permission check (409: nothing failed)', async () => {
        const res = await asLead('post', 'RAISED', '/retry-zoho-sync');
        expect(res.statusCode).toBe(409);
        expect(res.body.error.code).toBe('NOTHING_TO_RETRY');
      });

      // The point of letting a Team Lead create orders at all: they have to be
      // able to send what they made to Management. It waits for approval like
      // any MedRep's order and never touches Zoho from here.
      test('POST /submit → sends it to Management for approval', async () => {
        const res = await asLead('post', 'RAISED', '/submit');
        expect(res.statusCode).toBeLessThan(300);
        const row = await db.prepare('SELECT status, submitted_at FROM orders WHERE id = ?').get(planted.RAISED);
        expect(row.status).toBe('pending_management_approval');
        expect(row.submitted_at).toBeTruthy();
      });
    });

    describe('an order that is theirs outright (medrep_id is the lead)', () => {
      test('PATCH /details → 200', async () => {
        const res = await asLead('patch', 'OWN', '/details', { delivery_notes: 'mine' });
        expect(res.statusCode).toBe(200);
      });

      test('POST /submit → sends it to Management for approval', async () => {
        const res = await asLead('post', 'OWN', '/submit');
        expect(res.statusCode).toBeLessThan(300);
        const row = await db.prepare('SELECT status FROM orders WHERE id = ?').get(planted.OWN);
        expect(row.status).toBe('pending_management_approval');
      });
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
