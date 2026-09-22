/**
 * Sep 22, 2026 — split-invoicing orders: one GetMeds order, two Zoho Sales
 * Orders, when a line item is explicitly set to the OTHER `invoicing_from`
 * entity than the order's own. See services/orderSplitService.js and the
 * plan this was built from.
 *
 * NOTE: written against the plan's design, but not run — this machine's
 * local test-database setup (tests/globalSetup.js -> migrate.pg.js) is
 * currently blocked by a Windows Application Control policy refusing to
 * load PostgreSQL's plpgsql.dll, unrelated to this feature. Run `npx jest
 * orderSplitInvoicing` once that's resolved, before trusting this file.
 *
 * The single most important test here is the first one: a normal order
 * (no split) must behave BYTE-FOR-BYTE as it did before this feature
 * existed — that is the whole safety argument for building this as an
 * additive table next to `orders` rather than a rewrite of it.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const ordersController = require('../src/controllers/orders.controller');
const zohoRetryService = require('../src/services/zohoRetryService');
const { getSplitsForOrder } = require('../src/services/orderSplitService');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

const PRIMARY = 'Getmeds Philippines Inc.';
const SPLIT = '2mg Incorporated';

describe('split-invoicing orders', () => {
  let medrepId;
  let financeToken;
  let customerId;
  let productAId; // stays on the primary
  let productBId; // moved to the split entity
  const createdOrderIds = [];

  beforeAll(async () => {
    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    if (!medrep) throw new Error('Expected seeded medrep@getmeds.ph to exist — run `npm run setup` first.');
    medrepId = medrep.id;
    financeToken = await loginAs('finance@getmeds.ph');

    customerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('SPLIT-INVOICING-TEST Customer')).lastInsertRowid;

    productAId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, 'SPLITTEST-SKU-A', 100, 'box', 500, 1)`
    ).run('SPLIT-TEST Product A (CARBOGET-like)')).lastInsertRowid;
    productBId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, 'SPLITTEST-SKU-B', 50, 'box', 500, 1)`
    ).run('SPLIT-TEST Product B (PACLIGET-like)')).lastInsertRowid;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_split_sales_orders WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare(`DELETE FROM products WHERE sku LIKE 'SPLITTEST-SKU-%'`).run();
    await db.prepare(`DELETE FROM customers WHERE name = 'SPLIT-INVOICING-TEST Customer'`).run();
  });

  afterEach(() => jest.restoreAllMocks());

  function baseReq(overrides = {}) {
    return {
      user: { id: medrepId, name: 'Test MedRep', email: 'medrep@getmeds.ph', role: 'medrep' },
      body: {
        customer_id: customerId,
        delivery_address: '1 Split Invoicing St',
        invoicing_from: PRIMARY,
        items: [
          { product_id: productAId, quantity: 1 },
          { product_id: productBId, quantity: 1 }
        ],
        ...overrides
      },
      params: {}
    };
  }

  test('REGRESSION: an order with no item-level override creates exactly ONE Sales Order, no split row', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq(); // neither item overrides invoicing_from
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    const order = res.body.data.order;
    createdOrderIds.push(order.id);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].items).toHaveLength(2); // both items on the one call
    expect(order.zoho_so_id).toBeTruthy();

    const { rows } = await getSplitsForOrder(order.id);
    expect(rows).toHaveLength(0);
  });

  test('a line item set to the OTHER entity creates TWO Sales Orders and one split row', async () => {
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const req = baseReq({
      items: [
        { product_id: productAId, quantity: 1 }, // follows the order -> PRIMARY
        { product_id: productBId, quantity: 1, invoicing_from: SPLIT }
      ]
    });
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    const order = res.body.data.order;
    createdOrderIds.push(order.id);

    expect(spy).toHaveBeenCalledTimes(2);
    const primaryCall = spy.mock.calls.find((c) => c[0].invoicing_from === PRIMARY);
    const splitCall = spy.mock.calls.find((c) => c[0].invoicing_from === SPLIT);
    expect(primaryCall[0].items).toHaveLength(1);
    expect(primaryCall[0].items[0].product_id).toBe(productAId);
    expect(splitCall[0].items).toHaveLength(1);
    expect(splitCall[0].items[0].product_id).toBe(productBId);

    expect(order.zoho_so_id).toBeTruthy(); // primary written to the orders row as always

    const { rows } = await getSplitsForOrder(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].invoicing_from).toBe(SPLIT);
    expect(rows[0].zoho_so_id).toBeTruthy();
    expect(rows[0].zoho_so_id).not.toBe(order.zoho_so_id); // genuinely two different Sales Orders
    expect(rows[0].zoho_sync_status).toBe('synced');

    // order_items itself carries the tag on the one row that was overridden.
    const items = await db.prepare('SELECT product_id, invoicing_from FROM order_items WHERE order_id = ?').all(order.id);
    expect(items.find((i) => i.product_id === productBId).invoicing_from).toBe(SPLIT);
    expect(items.find((i) => i.product_id === productAId).invoicing_from).toBeNull();
  });

  test('a webhook naming the SPLIT Sales Order resolves to the order and updates the split row, not the primary columns', async () => {
    const req = baseReq({
      items: [
        { product_id: productAId, quantity: 1 },
        { product_id: productBId, quantity: 1, invoicing_from: SPLIT }
      ]
    });
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());
    const order = res.body.data.order;
    createdOrderIds.push(order.id);

    const { rows } = await getSplitsForOrder(order.id);
    const splitSoId = rows[0].zoho_so_id;
    const primarySoIdBefore = (await db.prepare('SELECT zoho_so_id FROM orders WHERE id = ?').get(order.id)).zoho_so_id;

    const webhookRes = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event: 'salesorder.confirmed', salesorder: { salesorder_id: splitSoId, status: 'confirmed' } });

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.action).toBe('SPLIT_SO_CONFIRMED');

    const splitAfter = (await getSplitsForOrder(order.id)).rows[0];
    expect(splitAfter.zoho_so_status).toBe('confirmed');

    // The primary's own columns are untouched by an event about the split.
    const orderAfter = await db.prepare('SELECT zoho_so_id, zoho_so_status FROM orders WHERE id = ?').get(order.id);
    expect(orderAfter.zoho_so_id).toBe(primarySoIdBefore);
    expect(orderAfter.zoho_so_status).not.toBe('confirmed');
  });

  test('Finance verifying only the primary does not clear the order; verifying the split too does', async () => {
    const req = baseReq({
      items: [
        { product_id: productAId, quantity: 1 },
        { product_id: productBId, quantity: 1, invoicing_from: SPLIT }
      ]
    });
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());
    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.status).toBe('ready_for_finance_verified');

    const splitId = (await getSplitsForOrder(order.id)).rows[0].id;

    const primaryVerify = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(primaryVerify.status).toBe(200);

    let statusAfterPrimary = (await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status;
    expect(statusAfterPrimary).toBe('ready_for_finance_verified'); // held — split still pending

    const splitVerify = await request(app)
      .post(`/api/finance/orders/${order.id}/splits/${splitId}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(splitVerify.status).toBe(200);
    expect(splitVerify.body.data.status).toBe('ready_for_draft_invoice');

    const statusAfterBoth = (await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status;
    expect(statusAfterBoth).toBe('ready_for_draft_invoice');
  });

  test('a rejection on the split holds the whole order', async () => {
    const req = baseReq({
      items: [
        { product_id: productAId, quantity: 1 },
        { product_id: productBId, quantity: 1, invoicing_from: SPLIT }
      ]
    });
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());
    const order = res.body.data.order;
    createdOrderIds.push(order.id);
    const splitId = (await getSplitsForOrder(order.id)).rows[0].id;

    const splitReject = await request(app)
      .post(`/api/finance/orders/${order.id}/splits/${splitId}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: false, reason: 'Account on hold for this entity' });
    expect(splitReject.status).toBe(200);

    const orderAfter = await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
    expect(orderAfter.status).toBe('on_hold');
  });

  test('zohoRetryService: a split retry does not trip the primary\'s "already has a Sales Order" guard, or vice versa', async () => {
    const req = baseReq({
      items: [
        { product_id: productAId, quantity: 1 },
        { product_id: productBId, quantity: 1, invoicing_from: SPLIT }
      ]
    });
    const res = makeRes();
    await ordersController.create(req, res, jest.fn());
    const order = res.body.data.order;
    createdOrderIds.push(order.id);

    // Both already synced by create() — enqueue a retry for each anyway (as
    // if a stale queue row existed) and confirm processOne recognizes both
    // as already-done independently, rather than one guard covering both.
    await zohoRetryService.enqueue({ orderId: order.id, payload: { items: [] }, error: 'stale' });
    await zohoRetryService.enqueue({ orderId: order.id, payload: { items: [] }, error: 'stale', invoicingFrom: SPLIT });

    const results = await zohoRetryService.processQueue({ force: true });
    const outcomes = results.filter((r) => r.orderId === order.id).map((r) => r.outcome);
    expect(outcomes).toEqual(['already_in_zoho', 'already_in_zoho']);
  });
});
