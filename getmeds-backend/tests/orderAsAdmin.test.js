/**
 * Sep 9, 2026 — Admin can raise an order.
 *
 * Admin is a superset of management everywhere else in this app (approvals,
 * exceptions, the Clients Directory, the Zoho import all accept both), and
 * order creation was the one thing it was shut out of. Opening it needs three
 * things to line up, and each is asserted here because each fails differently:
 *
 *   1. The ROUTE accepts admin. Without it, a 403 that reads like a bug.
 *   2. Admin can NAME the MedRep, in normal mode and not only TEST_MODE.
 *      Without it, every admin order is attributed to the admin's own account
 *      — which has no Division and no Salesperson — and Zoho rejects a Sales
 *      Order with no Salesperson, so the form would exist and produce nothing
 *      but failures.
 *   3. Admin can set Division/Salesperson MANUALLY, the same escape hatch
 *      management has for when no MedRep is being named.
 *
 * Runs against the mock adapter, so nothing here touches a real Zoho org.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const createdOrderIds = [];
let adminToken;
let financeToken;
let customer;
let product;
let medrep;

async function createAsAdmin(body) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      customer_id: customer.id,
      items: [{ product_id: product.id, quantity: 1, rate: 25 }],
      delivery_address: '1 Admin St, Manila',
      is_draft: true,
      ...body
    });
  if (res.body?.data?.order?.id) createdOrderIds.push(res.body.data.order.id);
  return res;
}

describe('Admin raising an order', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
    const finance = await request(app).post('/api/auth/login').send({ email: 'finance@getmeds.ph', password: 'demo123' });
    financeToken = finance.body.data.token;

    customer = await db.prepare('SELECT * FROM customers WHERE zoho_contact_id IS NOT NULL AND is_active = 1 LIMIT 1').get();
    product = await db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT 1').get();
    medrep = await db.prepare("SELECT * FROM users WHERE LOWER(role) = 'medrep' AND is_active = 1 LIMIT 1").get();
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('POST /api/orders accepts an admin', async () => {
    const res = await createAsAdmin({});
    expect(res.statusCode).toBe(201);
    expect(res.body.data.order.id).toBeTruthy();
  });

  test('a role with no business raising orders is still refused', async () => {
    // The route was widened, not opened. Finance verifies orders; it does not
    // raise them.
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        customer_id: customer.id,
        items: [{ product_id: product.id, quantity: 1, rate: 25 }],
        delivery_address: '1 Finance St'
      });
    expect(res.statusCode).toBe(403);
  });

  describe('naming the MedRep', () => {
    test('the picker is enabled for an admin outside TEST_MODE', async () => {
      // It used to be TEST_MODE-only for admin. An admin who cannot name the
      // MedRep raises every order against their own Salesperson-less account.
      const res = await request(app)
        .get('/api/orders/meta/medreps')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.medreps.length).toBeGreaterThan(0);
    });

    test('the order is attributed to the named MedRep, not to the admin', async () => {
      const res = await createAsAdmin({ medrep_id: medrep.id });
      expect(res.statusCode).toBe(201);

      const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
      expect(saved.medrep_id).toBe(medrep.id);
      // And their Salesperson comes with them — the whole point of naming one.
      expect(saved.salesperson).toBe(medrep.salesperson);
    });

    test('an id that is not an active MedRep is refused by name', async () => {
      const someoneElse = await db.prepare("SELECT id FROM users WHERE LOWER(role) = 'finance' LIMIT 1").get();
      const res = await createAsAdmin({ medrep_id: someoneElse.id });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MEDREP');
    });
  });

  describe('setting Division and Salesperson by hand', () => {
    test('an admin can type both instead of naming a MedRep', async () => {
      // The escape hatch management already had. An admin account has neither
      // value of its own, so without this the only way to raise an order that
      // Zoho will accept would be to name somebody else.
      // Division must be one of the app's own 15 (orders.controller.js's
      // DIVISIONS) — deliberately NOT the seeded MedRep's 'NORTH', which
      // predates that list and is correctly refused. Salesperson is checked
      // against Zoho's live list instead, so it uses a name the mock knows.
      // The two are independent checks and this exercises both.
      const res = await createAsAdmin({
        division: 'B&B',
        salesperson: medrep.salesperson
      });

      expect(res.statusCode).toBe(201);
      const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
      expect(saved.division).toBe('B&B');
      expect(saved.salesperson).toBe(medrep.salesperson);
    });

    test('an unknown Division is refused, for an admin too', async () => {
      const res = await createAsAdmin({ division: 'NOT-A-DIVISION' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toMatch(/division must be one of/);
    });

    test('a MedRep still cannot override their own Division or Salesperson', async () => {
      // Widening this to admin must not have widened it to everyone — a
      // MedRep's two values still come from their account, and a stray field
      // from an old client is ignored rather than honoured.
      const login = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${login.body.data.token}`)
        .send({
          customer_id: customer.id,
          items: [{ product_id: product.id, quantity: 1, rate: 25 }],
          delivery_address: '1 MedRep St',
          is_draft: true,
          division: 'HOS',
          salesperson: 'SOMEONE | Else'
        });

      expect(res.statusCode).toBe(201);
      createdOrderIds.push(res.body.data.order.id);

      const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
      expect(saved.salesperson).not.toBe('SOMEONE | Else');
    });
  });

  test('an admin order records who created it in GM Lead ID', async () => {
    // The order belongs to the MedRep; the admin who raised it is still named,
    // which is what that field is for.
    const res = await createAsAdmin({ medrep_id: medrep.id });
    const saved = await db.prepare('SELECT gm_lead_id FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(saved.gm_lead_id).toBeTruthy();
  });
});
