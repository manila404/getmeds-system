/**
 * Coverage for the Zoho sync retry/outbox mechanism (zohoRetryService.js)
 * and the admin endpoints that expose it. This is the automatic-retry half
 * promised by the "Zoho API downtime" demo scenario: orders.controller.js
 * enqueues a failed sync via zohoRetryService.enqueue(); this module is
 * responsible for actually retrying it, with exponential backoff, up to
 * ZOHO_RETRY_MAX_ATTEMPTS before giving up and flagging it for a human.
 */
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const zohoRetryService = require('../src/services/zohoRetryService');
const adminController = require('../src/controllers/admin.controller');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

describe('zohoRetryService', () => {
  let medrepId;
  let customerId;
  let productId;
  const createdOrderIds = [];

  beforeAll(async () => {
    // Clean up any stale test records from previous runs
    const staleOrders = await db.prepare(`
      SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'ZOHO-RETRY%') OR getmeds_order_id LIKE 'GM-TESTQ%'
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
    await db.prepare(`DELETE FROM products WHERE sku = 'ZOHORETRY-SKU-001'`).run();
    await db.prepare(`DELETE FROM customers WHERE name LIKE 'ZOHO-RETRY%'`).run();

    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    if (!medrep) throw new Error('Expected seeded medrep@getmeds.ph to exist — run `npm run setup` first.');
    medrepId = medrep.id;

    customerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('ZOHO-RETRY-TEST Customer')).lastInsertRowid;

    productId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, ?, ?, 'tab', 500, 1)`
    ).run('ZOHO-RETRY-TEST Product', 'ZOHORETRY-SKU-001', 10)).lastInsertRowid;
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
    if (customerId) await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  });

  beforeEach(async () => {
    // Each test enqueues its own row and drives processQueue({force:true}),
    // which (by design, to let an admin "retry everything now") ignores
    // next_attempt_at entirely — so a prior test's still-pending row would
    // otherwise get swept up in a later test's forced pass and steal its
    // mocked zoho.createSalesOrder call. Start every test with a clean queue.
    await db.prepare('DELETE FROM zoho_sync_queue').run();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function makeOrder(getmedsOrderId) {
    const now = new Date().toISOString();
    const result = await db.prepare(`
      INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, zoho_sync_status, created_at, submitted_at, updated_at)
      VALUES (?, ?, ?, 'so_pending', 'direct', 20, '1 Retry Test St', 'failed', ?, ?, ?)
    `).run(getmedsOrderId, customerId, medrepId, now, now, now);
    createdOrderIds.push(result.lastInsertRowid);
    return result.lastInsertRowid;
  }

  test('enqueue() + listQueue(): a queued row is visible with status=pending, attempts=0', async () => {
    const orderId = await makeOrder('GM-TESTQ-0001');
    await zohoRetryService.enqueue({ orderId, payload: { getmeds_order_id: 'GM-TESTQ-0001' }, error: 'boom' });

    const queue = await zohoRetryService.listQueue();
    const row = queue.find((q) => q.order_id === orderId);
    expect(row).toBeDefined();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBe('boom');
    expect(row.getmeds_order_id).toBe('GM-TESTQ-0001');
  });

  test('processQueue({force:true}): a successful retry backfills the order and marks the row succeeded', async () => {
    const orderId = await makeOrder('GM-TESTQ-0002');
    await zohoRetryService.enqueue({
      orderId,
      payload: {
        getmeds_order_id: 'GM-TESTQ-0002',
        customer_name: 'ZOHO-RETRY-TEST Customer',
        customer_type: 'direct',
        total_amount: 20,
        delivery_address: '1 Retry Test St',
        items: []
      },
      error: 'Zoho API is down'
    });

    const results = await zohoRetryService.processQueue({ force: true });
    const result = results.find((r) => r.orderId === orderId);
    expect(result.outcome).toBe('succeeded');

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    expect(order.zoho_sync_status).toBe('synced');
    expect(order.zoho_so_id).toMatch(/^MOCK-SO-\d{6}$/);

    const queueRow = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(orderId);
    expect(queueRow.status).toBe('succeeded');

    const recovered = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SYNC_RECOVERED'").all(orderId);
    expect(recovered.length).toBe(1);
  });

  test('processQueue(): without {force:true}, a row whose next_attempt_at is in the future is skipped', async () => {
    const orderId = await makeOrder('GM-TESTQ-0003');
    await zohoRetryService.enqueue({ orderId, payload: { getmeds_order_id: 'GM-TESTQ-0003' }, error: 'down' });

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.prepare('UPDATE zoho_sync_queue SET next_attempt_at = ? WHERE order_id = ?').run(future, orderId);

    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const results = await zohoRetryService.processQueue(); // no force
    expect(spy).not.toHaveBeenCalled();
    expect(results.find((r) => r.orderId === orderId)).toBeUndefined();

    const queueRow = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(orderId);
    expect(queueRow.status).toBe('pending'); // untouched
  });

  test('processQueue({force:true}): a retry that fails again increments attempts and schedules backoff', async () => {
    const orderId = await makeOrder('GM-TESTQ-0004');
    await zohoRetryService.enqueue({ orderId, payload: { getmeds_order_id: 'GM-TESTQ-0004', items: [] }, error: 'down' });

    jest.spyOn(zoho, 'createSalesOrder').mockRejectedValueOnce(new Error('still down'));
    const results = await zohoRetryService.processQueue({ force: true });
    const result = results.find((r) => r.orderId === orderId);

    expect(result.outcome).toBe('retry_scheduled');

    const queueRow = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(orderId);
    expect(queueRow.status).toBe('pending');
    expect(queueRow.attempts).toBe(1);
    expect(queueRow.last_error).toBe('still down');
    expect(new Date(queueRow.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('processQueue({force:true}): after MAX_ATTEMPTS consecutive failures, the row is marked failed_permanent', async () => {
    const orderId = await makeOrder('GM-TESTQ-0005');
    await zohoRetryService.enqueue({ orderId, payload: { getmeds_order_id: 'GM-TESTQ-0005', items: [] }, error: 'down' });

    for (let i = 0; i < zohoRetryService.MAX_ATTEMPTS; i++) {
      jest.spyOn(zoho, 'createSalesOrder').mockRejectedValueOnce(new Error(`still down #${i + 1}`));
      // eslint-disable-next-line no-await-in-loop
      await zohoRetryService.processQueue({ force: true });
    }

    const queueRow = await db.prepare('SELECT * FROM zoho_sync_queue WHERE order_id = ?').get(orderId);
    expect(queueRow.status).toBe('failed_permanent');
    expect(queueRow.attempts).toBe(zohoRetryService.MAX_ATTEMPTS);

    const permanentEvents = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SYNC_FAILED_PERMANENT'").all(orderId);
    expect(permanentEvents.length).toBe(1);

    // A failed_permanent row is no longer picked up by future passes.
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    spy.mockClear(); // clear the call history accumulated by the loop above; same spy instance
    await zohoRetryService.processQueue({ force: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('admin.controller — Zoho queue endpoints', () => {
  let medrepId;
  let customerId;
  const createdOrderIds = [];

  beforeAll(async () => {
    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    medrepId = medrep.id;
    customerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('ZOHO-ADMIN-TEST Customer')).lastInsertRowid;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('getZohoQueue: returns queue rows plus a status summary', async () => {
    const now = new Date().toISOString();
    const orderId = (await db.prepare(`
      INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, zoho_sync_status, created_at, updated_at)
      VALUES ('GM-TESTQ-ADMIN1', ?, ?, 'so_pending', 'direct', 20, '1 Admin Test St', 'failed', ?, ?)
    `).run(customerId, medrepId, now, now)).lastInsertRowid;
    createdOrderIds.push(orderId);
    await zohoRetryService.enqueue({ orderId, payload: { getmeds_order_id: 'GM-TESTQ-ADMIN1' }, error: 'down' });

    const req = {};
    const res = makeRes();
    await adminController.getZohoQueue(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.pending).toBeGreaterThanOrEqual(1);
    expect(res.body.data.queue.some((q) => q.order_id === orderId)).toBe(true);
  });

  test('retryZohoQueue: triggers an immediate forced pass and reports results', async () => {
    const now = new Date().toISOString();
    const orderId = (await db.prepare(`
      INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, zoho_sync_status, created_at, updated_at)
      VALUES ('GM-TESTQ-ADMIN2', ?, ?, 'so_pending', 'direct', 20, '1 Admin Test St', 'failed', ?, ?)
    `).run(customerId, medrepId, now, now)).lastInsertRowid;
    createdOrderIds.push(orderId);
    await zohoRetryService.enqueue({
      orderId,
      payload: { getmeds_order_id: 'GM-TESTQ-ADMIN2', customer_name: 'x', total_amount: 20, delivery_address: 'y', items: [] },
      error: 'down'
    });

    const req = {};
    const res = makeRes();
    await adminController.retryZohoQueue(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results.some((r) => r.orderId === orderId && r.outcome === 'succeeded')).toBe(true);
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    if (customerId) {
      await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
    }
  });
});
