/**
 * Coverage for ZOHO_DRY_RUN (Aug 27, 2026): while this env var is 'true',
 * orders.controller.js's create/submit must NEVER call zoho.createSalesOrder
 * — no HTTP request should leave this app for that call, for any customer,
 * regardless of ZOHO_TEST_CUSTOMER_ID. A fabricated local response is used
 * instead so the rest of the order flow (state machine, zoho_sync_status,
 * order id prefix) behaves exactly as if Zoho had answered, but nothing
 * ever reaches the real org. This is the mechanism that lets the app be
 * exercised against REAL customers/inventory (pulled in read-only via
 * sync-from-zoho / inventory sync-pull) with zero risk of a live write.
 */
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const ordersController = require('../src/controllers/orders.controller');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

describe('ZOHO_DRY_RUN — no Zoho call, ever, and the single-TEST-customer gate is bypassed', () => {
  let medrepId;
  let customerAId; // will be pointed at by ZOHO_TEST_CUSTOMER_ID
  let customerBId; // deliberately NOT the designated test customer
  let productId;
  const createdOrderIds = [];
  const originalDryRun = process.env.ZOHO_DRY_RUN;
  const originalTestCustomer = process.env.ZOHO_TEST_CUSTOMER_ID;

  beforeAll(() => {
    db.prepare(`DELETE FROM customers WHERE name LIKE 'DRYRUN-TEST%'`).run();
    db.prepare(`DELETE FROM products WHERE sku = 'DRYRUNTEST-SKU-001'`).run();

    const medrep = db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    if (!medrep) throw new Error('Expected seeded medrep@getmeds.ph to exist — run `npm run setup` first.');
    medrepId = medrep.id;

    customerAId = db.prepare(`
      INSERT INTO customers (name, type, zoho_contact_id, source, is_active) VALUES (?, 'credit', 'ZOHO-CONTACT-A', 'zoho', 1)
    `).run('DRYRUN-TEST Customer A').lastInsertRowid;
    customerBId = db.prepare(`
      INSERT INTO customers (name, type, zoho_contact_id, source, is_active) VALUES (?, 'credit', 'ZOHO-CONTACT-B', 'zoho', 1)
    `).run('DRYRUN-TEST Customer B').lastInsertRowid;
    productId = db.prepare(`
      INSERT INTO products (name, sku, unit_price, stock, unit, is_active) VALUES (?, 'DRYRUNTEST-SKU-001', 100, 50, 'box', 1)
    `).run('DRYRUN-TEST Product').lastInsertRowid;

    process.env.ZOHO_DRY_RUN = 'true';
    // Gate is deliberately pointed at Customer A, but Customer B must still
    // succeed below — dry run bypasses the gate entirely.
    process.env.ZOHO_TEST_CUSTOMER_ID = 'ZOHO-CONTACT-A';
  });

  afterAll(() => {
    if (originalDryRun === undefined) delete process.env.ZOHO_DRY_RUN; else process.env.ZOHO_DRY_RUN = originalDryRun;
    if (originalTestCustomer === undefined) delete process.env.ZOHO_TEST_CUSTOMER_ID; else process.env.ZOHO_TEST_CUSTOMER_ID = originalTestCustomer;

    for (const id of createdOrderIds) {
      db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    db.prepare(`DELETE FROM customers WHERE name LIKE 'DRYRUN-TEST%'`).run();
    db.prepare(`DELETE FROM products WHERE sku = 'DRYRUNTEST-SKU-001'`).run();
  });

  function baseReq(customerId, overrides = {}) {
    return {
      user: { id: medrepId, name: 'Test MedRep', email: 'medrep@getmeds.ph', role: 'medrep' },
      body: {
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: '1 Dry Run St',
        ...overrides
      },
      params: {}
    };
  }

  test('order for the gate-designated customer (A): zoho.createSalesOrder is never called, order id is DryGM-, status is skipped', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq(customerAId);
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);

    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.getmeds_order_id).toMatch(/^DryGM-\d{8}-\d{4}$/);
    expect(order.zoho_sync_status).toBe('skipped');
    expect(order.zoho_so_id).toMatch(/^DRYRUN-/);
  });

  test('order for a DIFFERENT customer (B, not the gate-designated one): still succeeds — dry run bypasses the gate', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq(customerBId);
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201); // NOT 403 TEST_CUSTOMER_ONLY

    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.getmeds_order_id).toMatch(/^DryGM-\d{8}-\d{4}$/);
    expect(order.zoho_sync_status).toBe('skipped');
  });

  test('meta/customers dropdown: shows every customer (not just the gate-designated one) and reports zoho_dry_run_enabled=true', async () => {
    // getCustomers reads req.query.include_inactive — Express always
    // provides req.query, so a hand-built stub has to as well.
    const req = { user: { id: medrepId, role: 'medrep' }, query: {} };
    const res = makeRes();
    const next = jest.fn();

    await ordersController.getCustomers(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body.data.zoho_dry_run_enabled).toBe(true);
    expect(res.body.data.test_customer_gate_enabled).toBe(false); // reported as off, since dry run overrides it
    const names = res.body.data.customers.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['DRYRUN-TEST Customer A', 'DRYRUN-TEST Customer B']));
  });

  test('submit() path (draft -> submit) also never calls Zoho and gets a DryGM- id', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const createReq = baseReq(customerAId, { status: 'draft' });
    const createRes = makeRes();
    await ordersController.create(createReq, createRes, jest.fn());
    const draftOrder = createRes.body.data.order;
    createdOrderIds.push(draftOrder.id);
    expect(draftOrder.status).toBe('draft');

    const submitReq = { user: createReq.user, params: { id: draftOrder.id }, body: {} };
    const submitRes = makeRes();
    await ordersController.submit(submitReq, submitRes, jest.fn());

    expect(spy).not.toHaveBeenCalled();
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.body.data.order.getmeds_order_id).toMatch(/^DryGM-\d{8}-\d{4}$/);
    expect(submitRes.body.data.zoho_sync_status).toBe('skipped');
    expect(submitRes.body.data.zoho.salesorder_id).toMatch(/^DRYRUN-/);
  });
});
