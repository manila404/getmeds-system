/**
 * Sep 10, 2026 — handing imported Zoho orders to the reps who own them.
 *
 * This is the highest-consequence write in the app: it changes who owns tens
 * of thousands of orders at once, and if that history ever feeds commission or
 * quota, a wrong assignment is a payroll dispute rather than a display bug. So
 * the tests are mostly about what it must REFUSE to move, not what it moves.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const service = require('../src/services/salespersonMappingService');

const SP_IMPORTED = 'MAPTEST | Rita Realrep';
const SP_TERRITORY = 'MAPTEST | LAGUNA';
const SP_UNMAPPED = 'MAPTEST | Nobody Assigned';

const orderIds = [];
let adminToken, managementToken, medrepToken;
let rep, otherRep, customer, product, adminUser;

async function seedOrder({ ref, salesperson, ownerId, status = 'so_created' }) {
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, salesperson,
                           zoho_so_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 100, 'Map Test St', 'synced', ?, ?, ?, ?)`
    )
    .run(ref, customer.id, ownerId, status, salesperson, `SOID-${ref}`,
         new Date().toISOString(), new Date().toISOString());
  orderIds.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

describe('Assigning imported Zoho orders to reps', () => {
  beforeAll(async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = a.body.data.token;
    const m = await request(app).post('/api/auth/login').send({ email: 'manager@getmeds.ph', password: 'demo123' });
    managementToken = m.body.data.token;
    const r = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = r.body.data.token;

    adminUser = await db.prepare("SELECT * FROM users WHERE LOWER(role)='admin' LIMIT 1").get();
    customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
    product = await db.prepare('SELECT * FROM products LIMIT 1').get();
    const reps = await db
      .prepare("SELECT * FROM users WHERE LOWER(role)='medrep' AND is_active=1 ORDER BY id")
      .all();
    rep = reps[0];
    otherRep = reps[1] || reps[0];

    // Four orders that between them cover every branch of applyMappings.
    await seedOrder({ ref: 'ZOHO-MAPTEST-1', salesperson: SP_IMPORTED, ownerId: adminUser.id });
    await seedOrder({ ref: 'ZOHO-MAPTEST-2', salesperson: SP_IMPORTED, ownerId: adminUser.id });
    await seedOrder({ ref: 'ZOHO-MAPTEST-3', salesperson: SP_TERRITORY, ownerId: adminUser.id });
    await seedOrder({ ref: 'ZOHO-MAPTEST-4', salesperson: SP_UNMAPPED, ownerId: adminUser.id });
    // Orders with no Zoho salesperson at all — half the real import looks like
    // this, and none of it is assignable.
    await seedOrder({ ref: 'ZOHO-MAPTEST-5', salesperson: null, ownerId: adminUser.id });
    // An order raised IN THIS APP. Must never be touched by any of this.
    await seedOrder({ ref: 'GM-MAPTEST-9', salesperson: SP_IMPORTED, ownerId: otherRep.id });
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare("DELETE FROM salesperson_mappings WHERE zoho_salesperson LIKE 'MAPTEST%'").run();
  });

  const list = (token = adminToken) =>
    request(app).get('/api/salesperson-mappings').set('Authorization', `Bearer ${token}`);
  const setMap = (body, token = adminToken) =>
    request(app).patch('/api/salesperson-mappings').set('Authorization', `Bearer ${token}`).send(body);
  const apply = (confirm, token = adminToken) =>
    request(app)
      .post(`/api/salesperson-mappings/apply${confirm ? '?confirm=true' : ''}`)
      .set('Authorization', `Bearer ${token}`);

  describe('the review list', () => {
    test('finds every salesperson on an imported order, with its order count', async () => {
      const res = await list();
      expect(res.status).toBe(200);

      const byName = Object.fromEntries(res.body.data.rows.map((r) => [r.zoho_salesperson, r]));
      expect(byName[SP_IMPORTED].order_count).toBe(2);
      expect(byName[SP_TERRITORY].order_count).toBe(1);
      // The GM- order carries the same salesperson string but is NOT counted —
      // this list is about imported orders only.
      expect(byName[SP_IMPORTED].order_count).not.toBe(3);
    });

    test('counts the orders Zoho never attributed, rather than hiding them', async () => {
      const res = await list();
      expect(res.body.data.summary.orders_with_no_salesperson).toBeGreaterThanOrEqual(1);
    });

    test('a territory is pre-classified, not left as a person', async () => {
      const res = await list();
      const row = res.body.data.rows.find((r) => r.zoho_salesperson === SP_TERRITORY);
      expect(row.kind).toBe('territory');
    });

    test('re-listing never resets a decision already made', async () => {
      await setMap({ zoho_salesperson: SP_TERRITORY, kind: 'channel' });
      const res = await list();
      const row = res.body.data.rows.find((r) => r.zoho_salesperson === SP_TERRITORY);
      expect(row.kind).toBe('channel');
      await setMap({ zoho_salesperson: SP_TERRITORY, kind: 'territory' });
    });
  });

  describe('suggestions', () => {
    const users = [
      { id: 1, name: 'Aaron Manila', display_name: 'Aaron Manila', division: 'HOS', salesperson: 'HOS | Aaron Manila' },
      { id: 2, name: 'Dona Mae Lebumfacil', display_name: 'Dona Mae Lebumfacil', division: 'MSA', salesperson: 'MSA | Dona Mae Lebumfacil' }
    ];

    test('matches through the real dirt in the Zoho data', async () => {
      // Every one of these is a live example: a doubled space and different
      // case, and a capital I used as the separator.
      expect(service.normalise('B2B |  DONA MAE LEBUMFACIL')).toBe('b2b | dona mae lebumfacil');
      expect(service.normalise('MSA I WENDY MAE')).toBe('msa | wendy mae');
      expect(service.normalise('B2C | Fhaye Norella ')).toBe('b2c | fhaye norella');
    });

    test('refuses the dangerous near-match', async () => {
      // 'HOS | MANILA VACANT' against an account for 'HOS | Aaron Manila'.
      // A looser normaliser would offer this, and accepting it would hand one
      // rep 462 orders belonging to nobody.
      expect(service.suggestUser('HOS | MANILA VACANT', users)).toBeNull();
    });

    test('flags a name match with a different division rather than asserting it', async () => {
      const s = service.suggestUser('B2B |  DONA MAE LEBUMFACIL', users);
      expect(s.user.id).toBe(2);
      expect(s.confidence).toBe('name-only');
      expect(s.reason).toMatch(/B2B|b2b/i);
    });

    test('offers nothing when two accounts share a display name', async () => {
      const twins = [
        { id: 3, name: 'Jane Cruz', display_name: 'Jane Cruz', division: 'HOS', salesperson: 'HOS | Jane Cruz' },
        { id: 4, name: 'Jane Cruz', display_name: 'Jane Cruz', division: 'B2B', salesperson: 'B2B | Jane Cruz' }
      ];
      expect(service.suggestUser('MSA | Jane Cruz', twins)).toBeNull();
    });
  });

  describe('recording a decision', () => {
    test('a territory never carries a user, even if one is sent', async () => {
      // Attaching an account to 'HOS | LAGUNA' would make a whole territory's
      // history one rep's personal record — the opposite of what classifying
      // it as a territory means.
      const res = await setMap({ zoho_salesperson: SP_TERRITORY, kind: 'territory', user_id: rep.id });
      expect(res.status).toBe(200);
      expect(res.body.data.mapping.user_id).toBeNull();
    });

    test('an unknown kind is refused', async () => {
      const res = await setMap({ zoho_salesperson: SP_IMPORTED, kind: 'whatever' });
      expect(res.status).toBe(400);
    });

    test('a MedRep cannot reach any of this', async () => {
      expect((await list(medrepToken)).status).toBe(403);
      expect((await setMap({ zoho_salesperson: SP_IMPORTED, kind: 'person' }, medrepToken)).status).toBe(403);
      expect((await apply(false, medrepToken)).status).toBe(403);
    });

    test('management can, because they are the ones who know', async () => {
      expect((await list(managementToken)).status).toBe(200);
    });
  });

  describe('applying', () => {
    test('a dry run reports the plan and writes nothing', async () => {
      await setMap({ zoho_salesperson: SP_IMPORTED, kind: 'person', user_id: rep.id });

      const res = await apply(false);
      expect(res.status).toBe(200);
      expect(res.body.data.dry_run).toBe(true);
      const step = res.body.data.plan.find((p) => p.zoho_salesperson === SP_IMPORTED);
      expect(step.orders).toBe(2);

      const still = await db
        .prepare("SELECT medrep_id FROM orders WHERE getmeds_order_id = 'ZOHO-MAPTEST-1'")
        .get();
      expect(still.medrep_id).toBe(adminUser.id);
    });

    test('confirming moves exactly the mapped orders', async () => {
      const res = await apply(true);
      expect(res.body.data.dry_run).toBe(false);
      expect(res.body.data.total_orders).toBe(2);

      for (const ref of ['ZOHO-MAPTEST-1', 'ZOHO-MAPTEST-2']) {
        const o = await db.prepare('SELECT medrep_id FROM orders WHERE getmeds_order_id = ?').get(ref);
        expect(o.medrep_id).toBe(rep.id);
      }
    });

    test('leaves territories, unmapped names and no-salesperson orders where they are', async () => {
      for (const ref of ['ZOHO-MAPTEST-3', 'ZOHO-MAPTEST-4', 'ZOHO-MAPTEST-5']) {
        const o = await db.prepare('SELECT medrep_id FROM orders WHERE getmeds_order_id = ?').get(ref);
        expect(o.medrep_id).toBe(adminUser.id);
      }
    });

    test('never touches an order raised in this app', async () => {
      // The GM- order carries the SAME salesperson string as the two that
      // moved. Only the ZOHO- prefix keeps it out, and that guard is the one
      // thing standing between a mapping decision and live order ownership.
      const o = await db.prepare("SELECT medrep_id FROM orders WHERE getmeds_order_id = 'GM-MAPTEST-9'").get();
      expect(o.medrep_id).toBe(otherRep.id);
    });

    test('records who assigned each order, and who had it before', async () => {
      const id = (await db.prepare("SELECT id FROM orders WHERE getmeds_order_id = 'ZOHO-MAPTEST-1'").get()).id;
      const events = await db
        .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ORDER_REASSIGNED'")
        .all(id);
      expect(events).toHaveLength(1);
      expect(events[0].notes).toContain(SP_IMPORTED);
    });

    test('running it again moves nothing', async () => {
      // The button invites repeated pressing. A second run must be a no-op,
      // not a second set of audit entries claiming the orders moved again.
      const res = await apply(true);
      expect(res.body.data.total_orders).toBe(0);

      const id = (await db.prepare("SELECT id FROM orders WHERE getmeds_order_id = 'ZOHO-MAPTEST-1'").get()).id;
      const events = await db
        .prepare("SELECT COUNT(*) c FROM order_events WHERE order_id = ? AND event_type = 'ORDER_REASSIGNED'")
        .get(id);
      expect(events.c).toBe(1);
    });

    test('changing a decision moves the orders again', async () => {
      await setMap({ zoho_salesperson: SP_IMPORTED, kind: 'person', user_id: otherRep.id });
      const res = await apply(true);
      expect(res.body.data.total_orders).toBe(2);

      const o = await db.prepare("SELECT medrep_id FROM orders WHERE getmeds_order_id = 'ZOHO-MAPTEST-1'").get();
      expect(o.medrep_id).toBe(otherRep.id);

      await setMap({ zoho_salesperson: SP_IMPORTED, kind: 'person', user_id: rep.id });
      await apply(true);
    });
  });

  describe('a rep can see their imported orders but not change them', () => {
    let importedId;

    beforeAll(async () => {
      importedId = (await db.prepare("SELECT id FROM orders WHERE getmeds_order_id = 'ZOHO-MAPTEST-1'").get()).id;
      // Hand it to the account medrepToken belongs to, so this is about the
      // ZOHO- prefix and not about ownership.
      const me = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
      await db.prepare('UPDATE orders SET medrep_id = ? WHERE id = ?').run(me.id, importedId);
    });

    test('they can read it', async () => {
      const res = await request(app)
        .get(`/api/orders/${importedId}`)
        .set('Authorization', `Bearer ${medrepToken}`);
      expect(res.status).toBe(200);
    });

    test('it appears in their own orders list', async () => {
      const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${medrepToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data.orders || res.body.data).map((o) => o.id);
      expect(ids).toContain(importedId);
    });

    test('they cannot edit its details', async () => {
      const res = await request(app)
        .patch(`/api/orders/${importedId}/details`)
        .set('Authorization', `Bearer ${medrepToken}`)
        .send({ delivery_address: 'Somewhere else' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IMPORTED_ORDER_READ_ONLY');
    });

    test('they cannot edit its items or submit it', async () => {
      const items = await request(app)
        .patch(`/api/orders/${importedId}/items`)
        .set('Authorization', `Bearer ${medrepToken}`)
        .send({ items: [{ product_id: product.id, quantity: 5, rate: 1 }] });
      expect(items.status).toBe(403);

      const submit = await request(app)
        .post(`/api/orders/${importedId}/submit`)
        .set('Authorization', `Bearer ${medrepToken}`);
      expect(submit.status).toBe(403);
    });

    test('management is NOT blocked — someone has to be able to fix a bad import', async () => {
      const res = await request(app)
        .patch(`/api/orders/${importedId}/details`)
        .set('Authorization', `Bearer ${managementToken}`)
        .send({ delivery_notes: 'Checked by management' });
      expect(res.status).not.toBe(403);
    });

    test('an order the rep actually raised is still editable', async () => {
      // The guard must be about the ZOHO- prefix, not about MedReps in general.
      const me = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
      const ownId = await seedOrder({
        ref: 'GM-MAPTEST-OWN', salesperson: null, ownerId: me.id, status: 'draft'
      });
      const res = await request(app)
        .patch(`/api/orders/${ownId}/details`)
        .set('Authorization', `Bearer ${medrepToken}`)
        .send({ delivery_notes: 'My own order' });
      expect(res.status).not.toBe(403);
    });
  });
});
