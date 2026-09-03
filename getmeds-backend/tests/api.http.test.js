/**
 * Controller-level API tests: real HTTP requests against the actual Express
 * app (routes + middleware + controllers all wired together), as opposed to
 * the other test files which call controller functions directly with
 * hand-built req/res objects. This is what was missing per the project's
 * "known limitations" — auth, RBAC enforcement, and full request/response
 * shapes are only genuinely covered when exercised over real HTTP.
 *
 * Covers: health check, login (success/failure), 401 with no token, 403 for
 * wrong role, and full HTTP walk-throughs of Scenario 1 (Fast-Track credit),
 * Scenario 2 (Gatekeeper direct), and Scenario 3 (Exception/Hold) — the same
 * three demo scenarios verified earlier, now proven over the real HTTP layer
 * instead of just by reading the code.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

describe('HTTP API — health, auth, RBAC', () => {
  test('GET /api/health is public and returns success', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/auth/login: wrong password returns 401 INVALID_CREDENTIALS', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('POST /api/auth/login: missing password returns 400 VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/auth/login: correct seeded credentials return a usable JWT', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user.role).toBe('medrep');
  });

  test('GET /api/orders with no Authorization header: 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('GET /api/orders with a garbage token: 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/orders').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('RBAC: a medrep token is forbidden from GET /api/admin/users (403)', async () => {
    const token = await loginAs('medrep@getmeds.ph');
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('RBAC: a medrep token is forbidden from GET /api/finance/queue (403)', async () => {
    const token = await loginAs('medrep@getmeds.ph');
    const res = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('RBAC: a dispatch token is forbidden from POST /api/finance/orders/:id/verify-payment (403)', async () => {
    const token = await loginAs('dispatch@getmeds.ph');
    const res = await request(app)
      .post('/api/finance/orders/999999/verify-payment')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'verified' });
    expect(res.status).toBe(403);
  });

  test('an admin token IS allowed into GET /api/admin/users (200)', async () => {
    const token = await loginAs('admin@getmeds.ph');
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('HTTP API — full scenario walk-throughs', () => {
  let creditCustomerId;
  let directCustomerId;
  let productId;
  const createdOrderIds = [];

  let medrepToken, financeToken, dispatchToken, managementToken;

  beforeAll(async () => {
    // Clean up any leftovers from previous failed test runs
    const staleOrders = await db.prepare(`
      SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'HTTP-TEST%')
    `).all();
    for (const o of staleOrders) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
    }
    await db.prepare(`DELETE FROM products WHERE sku = 'HTTPTEST-SKU-001'`).run();
    await db.prepare(`DELETE FROM customers WHERE name LIKE 'HTTP-TEST%'`).run();

    creditCustomerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'credit', 100000, 1)`
    ).run('HTTP-TEST Credit Customer')).lastInsertRowid;
    directCustomerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('HTTP-TEST Direct Customer')).lastInsertRowid;
    productId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, ?, ?, 'tab', 500, 1)`
    ).run('HTTP-TEST Product', 'HTTPTEST-SKU-001', 15)).lastInsertRowid;

    medrepToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    managementToken = await loginAs('manager@getmeds.ph');
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    if (productId) await db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    if (creditCustomerId && directCustomerId) {
      await db.prepare('DELETE FROM customers WHERE id IN (?, ?)').run(creditCustomerId, directCustomerId);
    }
  });

  // Sep 1, 2026: Scenarios 1–3 rewritten. They were still driving the local
  // POST /api/dispatch/orders/:id/update-status, /tracking and
  // /api/finance/orders/:id/verify-payment endpoints, which were retired on
  // Aug 26 when Finance and Dispatch moved into Zoho — so all three had been
  // failing with 404s ever since, against code that was working correctly.
  // They now drive the flow the way it actually runs: the app creates the
  // Sales Order, and every step after that arrives as a Zoho webhook.
  const zohoWebhook = (body) => request(app).post('/api/webhooks/zoho').send(body);

  test('Scenario 1 (credit): the full renamed spine, end to end', async () => {
    // 1. MedRep submits a credit-customer order via the digital form
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: creditCustomerId,
        items: [{ product_id: productId, quantity: 3 }],
        delivery_address: '1 HTTP Test St, Manila'
      });
    expect(createRes.status).toBe(201);
    const order = createRes.body.data.order;
    createdOrderIds.push(order.id);

    // 2. The app has created a DRAFT Sales Order in Zoho and nothing more.
    expect(order.getmeds_order_id).toMatch(/^GM-\d{8}-\d{4}$/);
    expect(order.status).toBe('so_created');
    expect(order.zoho_sync_status).toBe('synced');
    const soId = order.zoho_so_id;

    const statusNow = async () => {
      const d = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${medrepToken}`);
      return d.body.data.order.status;
    };
    const inDispatchQueue = async () => {
      const q = await request(app).get('/api/dispatch/queue').set('Authorization', `Bearer ${dispatchToken}`);
      return q.body.data.orders.some((o) => o.id === order.id);
    };
    const inFinanceQueue = async () => {
      const q = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${financeToken}`);
      return q.body.data.orders.some((o) => o.id === order.id);
    };

    expect(await inDispatchQueue()).toBe(false);

    // 3. Finance confirms the Sales Order → it goes to Finance for account
    // verification, which is the one stage Zoho has no record of.
    await zohoWebhook({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: soId, status: 'confirmed' } });
    expect(await statusNow()).toBe('ready_for_finance_verified');
    expect(await inFinanceQueue()).toBe(true);
    expect(await inDispatchQueue()).toBe(false);

    // 3b. Finance checks the customer's account in Zoho Books and approves.
    // This is an action in THIS app — no webhook can tell us it happened.
    const verifyRes = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(verifyRes.status).toBe(200);
    expect(await statusNow()).toBe('ready_for_draft_invoice');
    expect(await inFinanceQueue()).toBe(true);
    // Sep 1, 2026 (5): still NOT the warehouse's problem. Under the old
    // naming, confirming the SO dropped the order straight into the dispatch
    // queue; now the invoice has to be raised and issued first.
    expect(await inDispatchQueue()).toBe(false);

    // 4. Invoice raised → waiting to be issued.
    await zohoWebhook({
      event_type: 'invoice.created',
      invoice: { salesorder_id: soId, invoice_id: 'INV-S1', invoice_number: 'INV-S1-0001' }
    });
    expect(await statusNow()).toBe('ready_for_invoice_sent');
    expect(await inDispatchQueue()).toBe(false);

    // 5. Invoice issued to the customer → NOW it is the warehouse's.
    await zohoWebhook({
      event_type: 'invoice.sent',
      invoice: { salesorder_id: soId, invoice_id: 'INV-S1', invoice_number: 'INV-S1-0001', status: 'sent' }
    });
    expect(await statusNow()).toBe('ready_for_dispatch');
    expect(await inDispatchQueue()).toBe(true);

    // 6. Packed, then shipped with tracking — both from Zoho.
    await zohoWebhook({ event_type: 'package.created', package: { salesorder_id: soId, package_number: 'PKG-001' } });
    expect(await statusNow()).toBe('picking_packing');

    await zohoWebhook({
      event_type: 'shipment.created',
      shipment: { salesorder_id: soId, tracking_number: 'LBC123456789', carrier: 'LBC Express' }
    });
    // Shipped, but not finished — the customer still owes the money.
    expect(await statusNow()).toBe('tracking_shared');

    // 7. Payment lands last, on terms — this is what closes the order out.
    await zohoWebhook({
      event_type: 'payment.created',
      payment: { salesorder_id: soId, payment_number: 'PAY-0001', amount: order.total_amount, date: '2026-09-01' }
    });

    const detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${medrepToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.order.status).toBe('completed');
    expect(detail.body.data.dispatch.tracking_number).toBe('LBC123456789');
  });

  test('Scenario 2 (direct, invoice-first): drafted -> marked sent -> packed -> shipped -> paid', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: directCustomerId,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: '2 HTTP Test St, Manila'
      });
    expect(createRes.status).toBe(201);
    const order = createRes.body.data.order;
    createdOrderIds.push(order.id);
    expect(order.status).toBe('ready_for_draft_invoice');

    const soId = order.zoho_so_id;

    // Not visible to Dispatch yet
    const dispatchQueueBefore = await request(app).get('/api/dispatch/queue').set('Authorization', `Bearer ${dispatchToken}`);
    expect(dispatchQueueBefore.body.data.orders.some((o) => o.id === order.id)).toBe(false);

    // Visible to Finance
    const financeQueueRes = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${financeToken}`);
    expect(financeQueueRes.status).toBe(200);
    expect(financeQueueRes.body.data.orders.some((o) => o.id === order.id)).toBe(true);

    // Finance converts the Sales Order to an Invoice in Zoho
    await zohoWebhook({
      event_type: 'invoice.created',
      invoice: { salesorder_id: soId, invoice_id: 'INV-S2-1', invoice_number: 'INV-S2-0001' }
    });
    let detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${medrepToken}`);
    expect(detail.body.data.order.status).toBe('ready_for_invoice_sent');

    // …then marks it as Sent. Sep 1, 2026: this used to be indistinguishable
    // from the line above and produced a duplicate "drafted" entry.
    await zohoWebhook({
      event_type: 'invoice.sent',
      invoice: { salesorder_id: soId, invoice_id: 'INV-S2-1', invoice_number: 'INV-S2-0001', status: 'sent' }
    });
    detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${medrepToken}`);
    expect(detail.body.data.order.status).toBe('ready_for_dispatch');

    // Finance still owns it — an issued invoice isn't a paid one
    const financeQueueMid = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${financeToken}`);
    expect(financeQueueMid.body.data.orders.some((o) => o.id === order.id)).toBe(true);

    // …and Dispatch can now see it's theirs to pack
    const dispatchQueueAfter = await request(app).get('/api/dispatch/queue').set('Authorization', `Bearer ${dispatchToken}`);
    expect(dispatchQueueAfter.body.data.orders.some((o) => o.id === order.id)).toBe(true);

    // Packed, shipped, then paid last
    await zohoWebhook({ event_type: 'package.created', package: { salesorder_id: soId, package_number: 'PKG-S2' } });
    await zohoWebhook({
      event_type: 'shipment.created',
      shipment: { salesorder_id: soId, tracking_number: 'JRS-S2-4410', carrier: 'JRS Express' }
    });
    await zohoWebhook({
      event_type: 'payment.created',
      payment: { salesorder_id: soId, payment_number: 'GCASH-REF-001', amount: order.total_amount, date: '2026-09-01' }
    });

    detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${medrepToken}`);
    expect(detail.body.data.order.status).toBe('completed');

    // And it has left both queues
    const financeQueueEnd = await request(app).get('/api/finance/queue').set('Authorization', `Bearer ${financeToken}`);
    expect(financeQueueEnd.body.data.orders.some((o) => o.id === order.id)).toBe(false);
    const dispatchQueueEnd = await request(app).get('/api/dispatch/queue').set('Authorization', `Bearer ${dispatchToken}`);
    expect(dispatchQueueEnd.body.data.orders.some((o) => o.id === order.id)).toBe(false);
  });

  test('Scenario 3 (Exception/Hold): Management puts an order on hold with a full audit entry', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: directCustomerId,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: '3 HTTP Test St, Manila'
      });
    const order = createRes.body.data.order;
    createdOrderIds.push(order.id);

    // Sep 1, 2026: this used to go through Finance's verify-payment endpoint
    // with status 'rejected'. That endpoint is gone — payment now happens in
    // Zoho — so holding an order is a Management action via the Exception
    // Hub, which is the route that still exists and is still the one used.
    const holdRes = await request(app)
      .patch(`/api/orders/${order.id}/exception`)
      .set('Authorization', `Bearer ${managementToken}`)
      .send({ status: 'on_hold', reason: 'Payment reference could not be matched' });
    expect(holdRes.status).toBe(200);
    expect(holdRes.body.data.status).toBe('on_hold');

    // Audit trail: actor, timestamp, and reason are all captured
    const eventsRes = await request(app).get(`/api/orders/${order.id}/events`).set('Authorization', `Bearer ${managementToken}`);
    expect(eventsRes.status).toBe(200);
    const holdEvent = eventsRes.body.data.events.find((e) => e.event_type === 'EXCEPTION_SET');
    expect(holdEvent).toBeDefined();
    expect(holdEvent.new_status).toBe('on_hold');
    expect(holdEvent.notes).toContain('could not be matched');
    expect(holdEvent.actor_name).toEqual(expect.any(String));
    expect(holdEvent.created_at).toEqual(expect.any(String));

    // MedRep sees the order is on_hold in their own list
    const myOrdersRes = await request(app).get('/api/orders').set('Authorization', `Bearer ${medrepToken}`);
    const mine = myOrdersRes.body.data.orders.find((o) => o.id === order.id);
    expect(mine.status).toBe('on_hold');
  });
});

// ─── Sep 1, 2026 (8): POST /api/finance/orders/:id/verify ─────────────────────
//
// The one stage in the whole flow that Zoho cannot report and that this app
// therefore has to own outright. Scenario 1 covers the happy path inside the
// full spine; this block covers the edges around it — the ones that decide
// whether the trail is worth reading afterwards.
describe('HTTP API — finance account verification', () => {
  let customerId, productId;
  const createdOrderIds = [];
  let medrepToken, financeToken;

  const cleanupOrder = async id => {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  };

  beforeAll(async () => {
    const stale = await db.prepare(`
      SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'FINVERIFY-TEST%')
    `).all();
    for (const o of stale) await cleanupOrder(o.id);
    await db.prepare(`DELETE FROM products WHERE sku = 'FINVERIFY-SKU-001'`).run();
    await db.prepare(`DELETE FROM customers WHERE name LIKE 'FINVERIFY-TEST%'`).run();

    customerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'credit', 100000, 1)`
    ).run('FINVERIFY-TEST Customer')).lastInsertRowid;
    productId = (await db.prepare(
      `INSERT INTO products (name, sku, unit_price, unit, stock, is_active) VALUES (?, ?, ?, 'tab', 500, 1)`
    ).run('FINVERIFY-TEST Product', 'FINVERIFY-SKU-001', 20)).lastInsertRowid;

    medrepToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await cleanupOrder(id);
    if (productId) await db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    if (customerId) await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  });

  // An order sitting at ready_for_finance_verified, i.e. confirmed in Zoho and
  // waiting on the account check.
  const orderAwaitingVerification = async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: '9 Verify St, Manila'
      });
    expect(createRes.status).toBe(201);
    const order = createRes.body.data.order;
    createdOrderIds.push(order.id);
    await request(app).post('/api/webhooks/zoho').send({
      event_type: 'salesorder.confirmed',
      salesorder: { salesorder_id: order.zoho_so_id, status: 'confirmed' }
    });
    return order;
  };

  const statusOf = async id => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;
  const eventsOf = async id => await db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(id);

  test('approving moves the order to ready_for_draft_invoice and names the approver', async () => {
    const order = await orderAwaitingVerification();
    expect(await statusOf(order.id)).toBe('ready_for_finance_verified');

    const res = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready_for_draft_invoice');
    expect(await statusOf(order.id)).toBe('ready_for_draft_invoice');

    const ev = (await eventsOf(order.id)).find((e) => e.event_type === 'FINANCE_VERIFIED');
    expect(ev).toBeDefined();
    expect(ev.old_status).toBe('ready_for_finance_verified');
    expect(ev.new_status).toBe('ready_for_draft_invoice');
    // The whole point of recording this in-app rather than inferring it: a
    // named human is on the hook for the decision.
    expect(ev.actor_name).toEqual(expect.any(String));
    expect(ev.actor_name.length).toBeGreaterThan(0);
  });

  test('rejecting puts the order on hold and keeps the reason on the trail', async () => {
    const order = await orderAwaitingVerification();

    const res = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: false, reason: '48,000 overdue past 60 days' });

    expect(res.status).toBe(200);
    expect(await statusOf(order.id)).toBe('on_hold');

    const ev = (await eventsOf(order.id)).find((e) => e.event_type === 'FINANCE_REJECTED');
    expect(ev).toBeDefined();
    expect(ev.new_status).toBe('on_hold');
    expect(ev.notes).toContain('48,000 overdue');

    // The reason also has to survive where the Exception Hub reads it, not
    // only in the timeline.
    const row = await db.prepare('SELECT exception_reason FROM orders WHERE id = ?').get(order.id);
    expect(row.exception_reason).toContain('48,000 overdue');
  });

  test('rejecting without a reason is refused and changes nothing', async () => {
    const order = await orderAwaitingVerification();

    for (const body of [{ approved: false }, { approved: false, reason: '   ' }]) {
      const res = await request(app)
        .post(`/api/finance/orders/${order.id}/verify`)
        .set('Authorization', `Bearer ${financeToken}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect(await statusOf(order.id)).toBe('ready_for_finance_verified');
    expect((await eventsOf(order.id)).some((e) => e.event_type === 'FINANCE_REJECTED')).toBe(false);
  });

  test('a missing or non-boolean "approved" is refused', async () => {
    const order = await orderAwaitingVerification();

    for (const body of [{}, { approved: 'yes' }, { approved: 1 }]) {
      const res = await request(app)
        .post(`/api/finance/orders/${order.id}/verify`)
        .set('Authorization', `Bearer ${financeToken}`)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(await statusOf(order.id)).toBe('ready_for_finance_verified');
  });

  test('verifying an order that is not awaiting verification is a 409, not a silent no-op', async () => {
    const order = await orderAwaitingVerification();

    const first = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(first.status).toBe(200);

    // Double-click, or two people in the queue at once.
    const second = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('NOT_AWAITING_VERIFICATION');
    expect(await statusOf(order.id)).toBe('ready_for_draft_invoice');

    // And exactly one FINANCE_VERIFIED event, not two.
    expect((await eventsOf(order.id)).filter((e) => e.event_type === 'FINANCE_VERIFIED')).toHaveLength(1);
  });

  test('an unknown order id is a 404', async () => {
    const res = await request(app)
      .post('/api/finance/orders/999999/verify')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ approved: true });
    expect(res.status).toBe(404);
  });

  test('a MedRep cannot verify an account', async () => {
    const order = await orderAwaitingVerification();
    const res = await request(app)
      .post(`/api/finance/orders/${order.id}/verify`)
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({ approved: true });
    expect(res.status).toBe(403);
    expect(await statusOf(order.id)).toBe('ready_for_finance_verified');
  });

  test('an invoice raised in Zoho first moves the order on anyway, and says so', async () => {
    // This app cannot stop anyone invoicing directly in Zoho. When that
    // happens the order must NOT get stranded waiting for a verification
    // click that is never coming — but the trail has to record that the
    // check was skipped, or the audit silently loses a control step.
    const order = await orderAwaitingVerification();

    await request(app).post('/api/webhooks/zoho').send({
      event_type: 'invoice.created',
      invoice: { salesorder_id: order.zoho_so_id, invoice_id: 'INV-FV-1', invoice_number: 'INV-FV-0001' }
    });

    expect(await statusOf(order.id)).toBe('ready_for_invoice_sent');
    const notes = (await eventsOf(order.id)).map((e) => e.notes || '').join(' | ');
    expect(notes).toMatch(/not been marked Finance Verified/i);
  });
});
