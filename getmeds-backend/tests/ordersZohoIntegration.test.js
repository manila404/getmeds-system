/**
 * Coverage for the change made to orders.controller.js: the Zoho sales-order
 * call now happens (awaited) *before* the db.transaction() in both `create`
 * and `submit`, instead of synchronously inside it, because better-sqlite3
 * transactions cannot contain an `await`.
 *
 * These tests exercise the real controller functions against the real dev
 * SQLite database (same convention as tests/admin.test.js), using temporary
 * customer/product rows that are cleaned up afterwards, and the default
 * ZOHO_MODE=mock adapter (deterministic, no network).
 *
 * The "Zoho API downtime" cases validate the fail-safe (not fail-closed)
 * design: if the Zoho call rejects, the order is still created/submitted
 * and advances through the state machine normally — it is never blocked or
 * left half-written — with zoho_sync_status='failed' and a row queued in
 * zoho_sync_queue for automatic background retry (see zohoRetryService and
 * tests/zohoRetryService.test.js), matching the project's QA mandate to
 * account for Zoho API downtime explicitly without losing order data.
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

describe('orders.controller — Zoho call sequencing (create/submit)', () => {
  let medrepId;
  let creditCustomerId;
  let directCustomerId;
  let productId;
  const createdOrderIds = [];

  beforeAll(async () => {
    // Clean up any stale test records from previous runs
    const staleOrders = await db.prepare(`
      SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'ZOHO-TEST%')
    `).all();
    for (const o of staleOrders) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
    }
    await db.prepare(`DELETE FROM products WHERE sku = 'ZOHOTEST-SKU-001'`).run();
    await db.prepare(`DELETE FROM customers WHERE name LIKE 'ZOHO-TEST%'`).run();

    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    if (!medrep) throw new Error('Expected seeded medrep@getmeds.ph to exist — run `npm run setup` first.');
    medrepId = medrep.id;

    creditCustomerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'credit', 100000, 1)`
    ).run('ZOHO-TEST Credit Customer')).lastInsertRowid;

    directCustomerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('ZOHO-TEST Direct Customer')).lastInsertRowid;

    productId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, ?, ?, 'tab', 500, 1)`
    ).run('ZOHO-TEST Product', 'ZOHOTEST-SKU-001', 10)).lastInsertRowid;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    if (productId) await db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    if (creditCustomerId && directCustomerId) {
      await db.prepare('DELETE FROM customers WHERE id IN (?, ?)').run(creditCustomerId, directCustomerId);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function baseReq(overrides = {}) {
    return {
      user: { id: medrepId, name: 'Test MedRep', email: 'medrep@getmeds.ph', role: 'medrep' },
      body: {
        customer_id: directCustomerId,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: '1 ZOHO-TEST St',
        ...overrides
      },
      params: {}
    };
  }

  test('draft order: never calls Zoho, and is stored with zoho_sync_status=pending', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq({ status: 'draft' });
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);

    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.status).toBe('draft');
    expect(order.zoho_sync_status).toBe('pending');
    expect(order.zoho_so_id).toBeNull();
  });

  test('credit customer, submitted: calls Zoho, stores its SO id/number, skips the payment queue', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq({ customer_id: creditCustomerId });
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);

    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    // Sep 1, 2026: was a dispatch-ready state. A credit order now waits at
    // so_created until the salesorder.confirmed webhook arrives — creating a
    // Draft SO in Zoho is not the same as anyone having approved it.
    expect(order.status).toBe('so_created');
    expect(order.zoho_sync_status).toBe('synced');
    expect(order.zoho_so_id).toMatch(/^MOCK-SO-\d{6}$/);
    // The Zoho-side status baseline is seeded here, so the first "Confirm"
    // in Zoho diffs against 'draft' instead of against nothing.
    const seeded = await db.prepare('SELECT zoho_so_status FROM orders WHERE id = ?').get(order.id);
    expect(seeded.zoho_so_status).toBe('draft');

    const dispatch = await db.prepare('SELECT * FROM dispatch_records WHERE order_id = ?').get(order.id);
    const payment = await db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
    expect(dispatch).toBeDefined();
    expect(payment).toBeUndefined();
  });

  test('direct patient, submitted: calls Zoho, routes to the finance payment queue', async () => {
    const req = baseReq(); // direct customer, no status override -> not draft
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.status).toBe('ready_for_draft_invoice');
    expect(order.zoho_sync_status).toBe('synced');

    const payment = await db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
    expect(payment).toBeDefined();
    expect(payment.status).toBe('pending');
  });

  test('Zoho API downtime on create: order is still created (fail-safe) and queued for automatic retry', async () => {
    jest.spyOn(zoho, 'createSalesOrder').mockRejectedValueOnce(new Error('Zoho API is down'));

    const req = baseReq(); // direct customer -> would go to waiting_for_payment
    const res = makeRes();
    const next = jest.fn();

    await ordersController.create(req, res, next);

    // The request succeeds — Zoho downtime never surfaces as a failed order submission.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);

    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.status).toBe('ready_for_draft_invoice'); // internal workflow is not gated on Zoho
    expect(order.zoho_sync_status).toBe('failed');
    expect(order.zoho_so_id).toBeNull();

    const queued = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(order.id);
    expect(queued).toBeDefined();
    expect(queued.status).toBe('pending');
    expect(queued.attempts).toBe(0);
    expect(JSON.parse(queued.payload).getmeds_order_id).toBe(order.getmeds_order_id);

    const events = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SYNC_FAILED'").all(order.id);
    expect(events.length).toBe(1); // audit trail records the sync failure
  });

  test('submit: creates a draft first, then submitting it calls Zoho and updates status', async () => {
    // Arrange: create a draft (no Zoho call involved) via the real endpoint
    const createReq = baseReq({ customer_id: creditCustomerId, status: 'draft' });
    const createRes = makeRes();
    await ordersController.create(createReq, createRes, jest.fn());
    const draftOrder = createRes.body.data.order;
    createdOrderIds.push(draftOrder.id);
    expect(draftOrder.status).toBe('draft');

    // Act
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const submitReq = { user: createReq.user, params: { id: String(draftOrder.id) } };
    const submitRes = makeRes();
    const next = jest.fn();
    await ordersController.submit(submitReq, submitRes, next);

    // Assert
    expect(next).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(submitRes.body.success).toBe(true);
    // Sep 1, 2026: a credit order now stops at so_created — all this app has
    // done is create a DRAFT Sales Order in Zoho. It is released to
    // ready_for_dispatch by the salesorder.confirmed webhook, not by submit.
    expect(submitRes.body.data.order.status).toBe('so_created');
    expect(submitRes.body.data.zoho.salesorder_id).toMatch(/^MOCK-SO-\d{6}$/);

    const reloaded = await db.prepare('SELECT * FROM orders WHERE id = ?').get(draftOrder.id);
    expect(reloaded.zoho_sync_status).toBe('synced');
  });

  test('Zoho API downtime on submit: the draft still advances (fail-safe) and is queued for automatic retry', async () => {
    const createReq = baseReq({ status: 'draft' });
    const createRes = makeRes();
    await ordersController.create(createReq, createRes, jest.fn());
    const draftOrder = createRes.body.data.order;
    createdOrderIds.push(draftOrder.id);

    jest.spyOn(zoho, 'createSalesOrder').mockRejectedValueOnce(new Error('Zoho API is down'));

    const submitReq = { user: createReq.user, params: { id: String(draftOrder.id) } };
    const submitRes = makeRes();
    const next = jest.fn();
    await ordersController.submit(submitReq, submitRes, next);

    expect(next).not.toHaveBeenCalled();
    expect(submitRes.body.success).toBe(true);
    expect(submitRes.body.data.zoho).toBeNull();
    expect(submitRes.body.data.zoho_sync_status).toBe('failed');

    const reloaded = await db.prepare('SELECT * FROM orders WHERE id = ?').get(draftOrder.id);
    expect(reloaded.status).toBe('ready_for_draft_invoice'); // advanced normally, not stuck in draft
    expect(reloaded.zoho_sync_status).toBe('failed');

    const queued = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(draftOrder.id);
    expect(queued).toBeDefined();
    expect(queued.status).toBe('pending');
  });
});
