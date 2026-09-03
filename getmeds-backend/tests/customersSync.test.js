/**
 * Coverage for the Aug 27, 2026 customer-sync + single-TEST-customer gate:
 *  - customers.controller.js's syncFromZoho is a pure READ from Zoho
 *    (zoho.listContacts()) that only writes to the local `customers` table.
 *  - orders.controller.js's checkTestCustomerGate blocks Zoho Sales Order
 *    creation for any customer other than the one mapped to
 *    ZOHO_TEST_CUSTOMER_ID, when that env var is set.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

describe('Customers — Zoho sync (read-only) and single-TEST-customer gate', () => {
  let adminToken;
  let medrepToken;
  let medrepId;
  let productId;
  const cleanupCustomerIds = [];
  const cleanupOrderIds = [];

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = adminRes.body.data.token;

    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;
    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    medrepId = medrep.id;

    productId = (await db.prepare(`SELECT id FROM products WHERE is_active = 1 LIMIT 1`).get()).id;

    // Clean slate for any customer this suite pulled from Zoho previously
    await db.prepare(`DELETE FROM customers WHERE source = 'zoho'`).run();
  });

  afterAll(async () => {
    delete process.env.ZOHO_TEST_CUSTOMER_ID;
    for (const id of cleanupOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare(`DELETE FROM customers WHERE source = 'zoho'`).run();
  });

  test('POST /api/customers/sync-from-zoho pulls mock contacts into the local table without ever calling a Zoho write', async () => {
    const res = await request(app)
      .post('/api/customers/sync-from-zoho')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBeGreaterThan(0);

    const pulled = await db.prepare(`SELECT * FROM customers WHERE source = 'zoho'`).all();
    expect(pulled.length).toBeGreaterThan(0);
    for (const c of pulled) {
      expect(c.zoho_contact_id).toBeTruthy();
      cleanupCustomerIds.push(c.id);
    }
  });

  test('POST /api/customers/sync-from-zoho is idempotent — running it again refreshes, does not duplicate', async () => {
    const before = (await db.prepare(`SELECT COUNT(*) as n FROM customers WHERE source = 'zoho'`).get()).n;

    const res = await request(app)
      .post('/api/customers/sync-from-zoho')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.updated).toBeGreaterThan(0);

    const after = (await db.prepare(`SELECT COUNT(*) as n FROM customers WHERE source = 'zoho'`).get()).n;
    expect(after).toBe(before);
  });

  test('RBAC: MedRep cannot trigger the Zoho customer pull', async () => {
    const res = await request(app)
      .post('/api/customers/sync-from-zoho')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(403);
  });

  test('GET /api/customers/meta dropdown (orders.controller.getCustomers) shows everyone when the gate is off', async () => {
    delete process.env.ZOHO_TEST_CUSTOMER_ID;
    const res = await request(app)
      .get('/api/orders/meta/customers')
      .set('Authorization', `Bearer ${medrepToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.test_customer_gate_enabled).toBe(false);
    expect(res.body.data.customers.length).toBeGreaterThan(1);
  });

  test('gate ON: order-creation dropdown shows only the designated TEST customer, and creating an order for anyone else is rejected', async () => {
    const zohoCustomer = await db.prepare(`SELECT * FROM customers WHERE source = 'zoho' LIMIT 1`).get();
    expect(zohoCustomer).toBeDefined();
    process.env.ZOHO_TEST_CUSTOMER_ID = zohoCustomer.zoho_contact_id;

    const dropdownRes = await request(app)
      .get('/api/orders/meta/customers')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(dropdownRes.body.data.test_customer_gate_enabled).toBe(true);
    expect(dropdownRes.body.data.customers).toHaveLength(1);
    expect(dropdownRes.body.data.customers[0].id).toBe(zohoCustomer.id);

    // A non-test local customer (seeded, source='local') must be rejected
    const otherCustomer = await db.prepare(`SELECT * FROM customers WHERE source = 'local' AND is_active = 1 LIMIT 1`).get();
    const rejectedRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: otherCustomer.id,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: '1 Gate Test St'
      });
    expect(rejectedRes.status).toBe(403);
    expect(rejectedRes.body.error.code).toBe('TEST_CUSTOMER_ONLY');

    // The designated TEST customer must still be allowed through, and its
    // Zoho Sales Order is created against that exact Zoho contact id.
    const allowedRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: zohoCustomer.id,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: '1 Gate Test St'
      });
    expect(allowedRes.status).toBe(201);
    cleanupOrderIds.push(allowedRes.body.data.order.id);
    expect(allowedRes.body.data.order.zoho_sync_status).toBe('synced');

    // While the gate is on, the order id itself — which becomes the Zoho
    // SO's reference_number and flows into its notes — is unmistakably
    // marked, so nobody downstream in Zoho mistakes it for a real order.
    expect(allowedRes.body.data.order.getmeds_order_id).toMatch(/^TestGM-\d{8}-\d{4}$/);
    const zohoSo = await zoho.getSalesOrder(allowedRes.body.data.order.zoho_so_id);
    expect(zohoSo.salesorder.notes).toMatch(/^TEST — DO NOT FULFILL\./);
  });
});
