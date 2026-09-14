/**
 * Dispatch works in Getmeds, after Finance's Verify (GETMEDS_WORKFLOW_V2).
 *
 * Sep 12, 2026; reworked Sep 14 in the merge with the Sep 12 change that made
 * Finance's Verify confirm the Sales Order in Zoho. That half has its own
 * suite (tests/financeConfirmsZoho.test.js). This one covers what the switch
 * adds on top of it:
 *
 *   - Verify asks for the two ticks, and respects dry run and the
 *     test-customer list before it touches Zoho
 *   - a direct order goes to Finance as well
 *   - each Dispatch step, and the rails the build plan asked for — one Zoho
 *     write when two people press the same button, adopting what someone
 *     already made in Zoho, stopping on a voided Sales Order
 *   - Create invoice finishing a confirmation Verify could not make
 *   - Retry never creating a second Sales Order
 *   - Zoho's report of our own change not being logged or notified twice
 *
 * Runs against the in-memory mock Zoho (tests/setupEnv.js forces it). The
 * switch and the two safety flags are read per request, so each test sets
 * them for itself and they are restored afterwards.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const zohoRetryService = require('../src/services/zohoRetryService');

const SEED_PASSWORD = 'demo123';
const ENV_KEYS = ['GETMEDS_WORKFLOW_V2', 'ZOHO_DRY_RUN', 'ZOHO_TEST_CUSTOMER_IDS', 'ZOHO_TEST_CUSTOMER_ID'];

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

let financeToken;
let dispatchToken;
let medrepToken;
let adminToken;
let managementToken;
let customerId;
let medrepId;
let productId;
let seq = 0;
const savedEnv = {};
const createdOrderIds = [];
const createdUserIds = [];

/** A Getmeds order sitting at `status`, with a real (mock) draft Sales Order behind it. */
async function makeOrder({ status = 'ready_for_finance_verified' } = {}) {
  seq += 1;
  const ref = `WF2-${Date.now()}-${seq}`;
  const { salesorder } = await zoho.createSalesOrder({
    getmeds_order_id: ref,
    customer_name: 'FIXTURE Direct Customer',
    customer_type: 'direct',
    customer_master_type: 'direct',
    zoho_customer_id: 'FIXTURE-CONTACT-1',
    total_amount: 125,
    delivery_address: '1 Fixture St, Manila',
    salesperson_name: 'TEST | MEDREP',
    items: [{ sku: 'FIX-PARA-500', name: 'FIXTURE Paracetamol 500mg', quantity: 10, unit_price: 12.5, subtotal: 125 }]
  });
  // zoho_detail_synced_at is set so these rows never look like imported
  // orders still waiting for their detail read — zohoOrderImport.test.js counts
  // exactly those, across the whole shared test database, while it runs.
  const row = await db.prepare(`
    INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                        delivery_address, zoho_so_id, zoho_so_number, zoho_so_status, zoho_detail_synced_at)
    VALUES (?, ?, ?, ?, 'direct', 125, '1 Fixture St, Manila', ?, ?, 'draft', ?)
    RETURNING id
  `).get(ref, customerId, medrepId, status, salesorder.salesorder_id, salesorder.salesorder_number, new Date().toISOString());
  return { id: row.id, ref, soId: salesorder.salesorder_id };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
const TICKED = { approved: true, pricesChecked: true, proofChecked: true };
const verify = (id, body = TICKED, token = financeToken) =>
  request(app).post(`/api/finance/orders/${id}/verify`).set(as(token)).send(body);
const dispatchStep = (id, step, body = {}, token = dispatchToken) =>
  request(app).post(`/api/dispatch/orders/${id}/${step}`).set(as(token)).send(body);

const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const dispatchRow = (id) => db.prepare('SELECT * FROM dispatch_records WHERE order_id = ?').get(id);
const eventsOf = (id, type) => db.prepare('SELECT * FROM order_events WHERE order_id = ? AND event_type = ? ORDER BY id').all(id, type);
const notificationCount = async (id) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE order_id = ?').get(id)).n);
const zohoSoStatus = async (soId) => (await zoho.getSalesOrder(soId)).salesorder.status;

/** An order Finance has verified, so it waits in Dispatch's "Needs invoice". */
async function verifiedOrder() {
  const order = await makeOrder();
  const res = await verify(order.id);
  if (res.status !== 200) throw new Error(`verify failed: ${JSON.stringify(res.body)}`);
  return order;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Every suite's mock Zoho numbers its Sales Orders from MOCK-SO-000001, and
  // the suites share one database. Starting this one high keeps its ids from
  // landing on the ones zohoOrderImport.test.js's mock hands out, which would
  // otherwise read to that suite as Sales Orders already imported.
  zoho.getZohoAdapter()._soCounter = 700000 + (process.pid % 1000) * 100;
  financeToken = await loginAs('finance@getmeds.ph');
  dispatchToken = await loginAs('dispatch@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  adminToken = await loginAs('admin@getmeds.ph');
  customerId = (await db.prepare(`SELECT id FROM customers WHERE zoho_contact_id = 'FIXTURE-CONTACT-1'`).get()).id;
  medrepId = (await db.prepare(`SELECT id FROM users WHERE email = 'medrep@getmeds.ph'`).get()).id;
  productId = (await db.prepare('SELECT id FROM products LIMIT 1').get()).id;

  // Own manager, the way managementRaisedOrder.test.js does it: which
  // management accounts are seeded varies, and reusing the seeded rep's hash
  // lets loginAs work without bcrypt here.
  const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
  const mgrEmail = `wf2-mgr-${Date.now()}@getmeds.ph`;
  await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'management')")
    .run('WF2 Manager', mgrEmail, seed.password_hash);
  createdUserIds.push((await db.prepare('SELECT id FROM users WHERE email = ?').get(mgrEmail)).id);
  managementToken = await loginAs(mgrEmail);
});

beforeEach(() => {
  process.env.GETMEDS_WORKFLOW_V2 = 'true';
  delete process.env.ZOHO_DRY_RUN;
  delete process.env.ZOHO_TEST_CUSTOMER_IDS;
  delete process.env.ZOHO_TEST_CUSTOMER_ID;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // The suites share one database. Orders left behind here carry mock Sales
  // Order ids, and a suite that runs later — the Zoho import, above all —
  // would find them and treat its own mock Sales Orders as already imported.
  const mine = `SELECT id FROM orders WHERE getmeds_order_id LIKE 'WF2-%' OR id = ANY(?)`;
  for (const table of ['notifications', 'order_events', 'dispatch_records', 'zoho_sync_queue']) {
    await db.prepare(`DELETE FROM ${table} WHERE order_id IN (${mine})`).run([createdOrderIds]);
  }
  await db.prepare(`DELETE FROM orders WHERE getmeds_order_id LIKE 'WF2-%' OR id = ANY(?)`).run([createdOrderIds]);
  for (const id of createdUserIds) {
    // Best effort: another suite may have notified this manager meanwhile,
    // and a leftover test account is harmless where a failed suite is not.
    try { await db.prepare('DELETE FROM users WHERE id = ?').run(id); } catch (_) { /* referenced elsewhere */ }
  }
});

describe('Workflow v2 — the switch', () => {
  test('switched off, every Dispatch action answers 404 FEATURE_OFF and nothing reaches Zoho', async () => {
    process.env.GETMEDS_WORKFLOW_V2 = 'false';
    const order = await makeOrder({ status: 'ready_for_draft_invoice' });
    const spy = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');

    for (const step of ['invoice', 'pack', 'ship', 'deliver']) {
      const r = await dispatchStep(order.id, step);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('FEATURE_OFF');
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('ready_for_draft_invoice');
  });

  test('switched off, Verify asks for no ticks and the queues report the switch', async () => {
    process.env.GETMEDS_WORKFLOW_V2 = 'false';
    const order = await makeOrder();
    expect((await verify(order.id, { approved: true })).status).toBe(200);

    const fin = await request(app).get('/api/finance/queue').set(as(financeToken));
    expect(fin.body.data.workflow_v2).toBe(false);
    const dis = await request(app).get('/api/dispatch/queue').set(as(dispatchToken));
    expect(dis.body.data.workflow_v2).toBe(false);
  });
});

describe('Workflow v2 — Finance', () => {
  test('the Finance queue reports the switch, so the page draws the ticks', async () => {
    const res = await request(app).get('/api/finance/queue').set(as(financeToken));
    expect(res.status).toBe(200);
    expect(res.body.data.workflow_v2).toBe(true);
  });

  test('Verify needs both ticks before it confirms anything', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder');

    const res = await verify(order.id, { approved: true, pricesChecked: true, proofChecked: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKS_REQUIRED');
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('ready_for_finance_verified');
  });

  test('Verify with both ticks confirms the Sales Order in Zoho and records what was checked', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder');

    const res = await verify(order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready_for_draft_invoice');
    expect(res.body.data.zohoConfirmed).toEqual(expect.objectContaining({ ok: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await zohoSoStatus(order.soId)).toBe('confirmed');

    const verified = await eventsOf(order.id, 'FINANCE_VERIFIED');
    expect(verified).toHaveLength(1);
    expect(JSON.parse(verified[0].metadata)).toEqual(expect.objectContaining({ pricesChecked: true, proofChecked: true }));
    expect(await eventsOf(order.id, 'ZOHO_SO_CONFIRMED')).toHaveLength(1);
  });

  test('Hold needs a reason, not the ticks, and confirms nothing', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder');
    const res = await verify(order.id, { approved: false, reason: 'Line 1 does not match the quotation' });
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('on_hold');
  });

  test('dry run: Verify stands and nothing is sent to Zoho', async () => {
    process.env.ZOHO_DRY_RUN = 'true';
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder');

    const res = await verify(order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.zohoConfirmed).toEqual(expect.objectContaining({ ok: true, dryRun: true }));
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).zoho_so_status).toBe('confirmed');
  });

  test('test-customer gate: Verify stands, Zoho is left alone, and nothing is marked failed', async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = 'SOME-OTHER-CONTACT';
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder');

    const res = await verify(order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.zohoConfirmed).toEqual(expect.objectContaining({ ok: false, skipped: true }));
    expect(spy).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.zoho_sync_status).not.toBe('failed');
  });

  test('a direct order goes to Finance, with the switch on or off', async () => {
    const raise = () => request(app).post('/api/orders').set(as(managementToken)).send({
      customer_id: customerId,
      medrep_id: medrepId,
      customer_type: 'direct',
      delivery_address: '1 WF2 St',
      no_payment_proof_reason: 'payment_to_follow',
      items: [{ product_id: productId, quantity: 1, unit_price: 125 }]
    });
    const statusOf = async (res) => {
      expect([200, 201]).toContain(res.status);
      const id = res.body.data.order.id;
      createdOrderIds.push(id);
      // Same reason as makeOrder: keep the import suite from counting it.
      await db.prepare('UPDATE orders SET zoho_detail_synced_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return (await orderRow(id)).status;
    };

    expect(await statusOf(await raise())).toBe('ready_for_finance_verified');
    // Sep 14, 2026: this used to pin a direct order skipping Finance with the
    // switch off. That is the gap GM-20260914-0006 fell through — approved by
    // Management, then on to invoicing with nobody checking the account — so
    // the rule is unconditional now, and so is this expectation.
    process.env.GETMEDS_WORKFLOW_V2 = 'false';
    expect(await statusOf(await raise())).toBe('ready_for_finance_verified');
  });
});

describe('Workflow v2 — Dispatch', () => {
  test('invoice → pack → ship → deliver after Verify, each step writing to Zoho once', async () => {
    const order = await verifiedOrder();

    const queue = await request(app).get('/api/dispatch/queue').set(as(dispatchToken));
    expect(queue.body.data.workflow_v2).toBe(true);
    expect(queue.body.data.orders.map((o) => o.id)).toContain(order.id);

    const invoiceSpy = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');
    const inv = await dispatchStep(order.id, 'invoice');
    expect(inv.status).toBe(200);
    expect(inv.body.data.status).toBe('ready_for_dispatch');
    expect(invoiceSpy).toHaveBeenCalledTimes(1);
    const afterInvoice = await orderRow(order.id);
    expect(afterInvoice.zoho_invoice_id).toBeTruthy();
    const so1 = (await zoho.getSalesOrder(order.soId)).salesorder;
    expect(so1.invoices).toEqual([expect.objectContaining({ invoice_id: afterInvoice.zoho_invoice_id, status: 'sent' })]);

    const pack = await dispatchStep(order.id, 'pack');
    expect(pack.status).toBe(200);
    expect(pack.body.data.status).toBe('picking_packing');
    expect((await dispatchRow(order.id)).zoho_package_id).toBeTruthy();

    const noTracking = await dispatchStep(order.id, 'ship', { courier: 'LBC' });
    expect(noTracking.status).toBe(400);

    const ship = await dispatchStep(order.id, 'ship', { courier: 'LBC', trackingNumber: 'TRK-WF2-1' });
    expect(ship.status).toBe(200);
    expect(['tracking_shared', 'completed']).toContain(ship.body.data.status);
    const shipped = await dispatchRow(order.id);
    expect(shipped).toEqual(expect.objectContaining({ status: 'dispatched', courier: 'LBC', tracking_number: 'TRK-WF2-1' }));
    expect(shipped.zoho_shipment_id).toBeTruthy();

    const deliver = await dispatchStep(order.id, 'deliver');
    expect(deliver.status).toBe(200);
    expect((await dispatchRow(order.id)).delivered_at).toBeTruthy();
    const so2 = (await zoho.getSalesOrder(order.soId)).salesorder;
    expect(so2.packages[0].shipment_status).toBe('delivered');

    const again = await dispatchStep(order.id, 'deliver');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DELIVERED');

    const after = await request(app).get('/api/dispatch/queue').set(as(dispatchToken));
    expect(after.body.data.orders.map((o) => o.id)).not.toContain(order.id);
  });

  test('Create invoice finishes a confirmation that Verify could not make', async () => {
    const order = await makeOrder();
    const confirmSpy = jest.spyOn(zoho, 'confirmSalesOrder')
      .mockRejectedValueOnce(new Error('Zoho did not respond within 30s'));

    const v = await verify(order.id);
    expect(v.status).toBe(200);
    expect(v.body.data.zohoConfirmed.ok).toBe(false);
    const stranded = await orderRow(order.id);
    expect(stranded.status).toBe('ready_for_draft_invoice');
    expect(stranded.zoho_sync_status).toBe('failed');
    expect(await zohoSoStatus(order.soId)).toBe('draft');

    const inv = await dispatchStep(order.id, 'invoice');
    expect(inv.status).toBe(200);
    expect(inv.body.data.status).toBe('ready_for_dispatch');
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(await zohoSoStatus(order.soId)).toBe('confirmed');

    const row = await orderRow(order.id);
    expect(row.zoho_so_status).toBe('confirmed');
    expect(row.zoho_sync_status).toBe('synced');
    const confirmed = (await eventsOf(order.id, 'ZOHO_SO_CONFIRMED')).map((e) => JSON.parse(e.metadata || '{}'));
    expect(confirmed).toEqual([expect.objectContaining({ via: 'create_invoice', zohoSoId: order.soId })]);
  });

  test('without a Finance verification, Create invoice will not confirm a draft Sales Order', async () => {
    // e.g. a direct order that reached this step before the switch was on.
    const order = await makeOrder({ status: 'ready_for_draft_invoice' });
    const spies = ['confirmSalesOrder', 'createInvoiceFromSalesOrder'].map((m) => jest.spyOn(zoho, m));

    const res = await dispatchStep(order.id, 'invoice');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CONFIRMED_IN_ZOHO');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.action_claim).toBeNull();
  });

  test('two people pressing Create invoice at once make ONE invoice in Zoho', async () => {
    const order = await verifiedOrder();
    const spy = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');

    const [a, b] = await Promise.all([dispatchStep(order.id, 'invoice'), dispatchStep(order.id, 'invoice')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['ALREADY_IN_PROGRESS', 'NOT_AT_THIS_STEP']).toContain(loser.body.error.code);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('an invoice someone already made in Zoho is recorded, not made a second time', async () => {
    const order = await verifiedOrder();
    const so = (await zoho.getSalesOrder(order.soId)).salesorder;
    const { invoice } = await zoho.createInvoiceFromSalesOrder(so);

    const spy = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');
    const res = await dispatchStep(order.id, 'invoice');
    expect(res.status).toBe(200);
    expect(res.body.data.adopted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).zoho_invoice_id).toBe(invoice.invoice_id);
  });

  test('a Sales Order voided in Zoho stops the step, and the order is left as it was', async () => {
    const order = await verifiedOrder();
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
      code: 0,
      salesorder: { salesorder_id: order.soId, salesorder_number: 'SO-VOID', status: 'void' }
    });
    const write = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');

    const res = await dispatchStep(order.id, 'invoice');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOIDED_IN_ZOHO');
    expect(write).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.action_claim).toBeNull();
  });

  test('Zoho refusing a write comes back as a clear 502, and the step can be tried again', async () => {
    const order = await verifiedOrder();
    expect((await dispatchStep(order.id, 'invoice')).status).toBe(200);
    jest.spyOn(zoho, 'createPackageForSalesOrder').mockRejectedValueOnce(new Error('This Sales Order is locked'));

    const res = await dispatchStep(order.id, 'pack');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ZOHO_WRITE_FAILED');
    expect(res.body.error.message).toMatch(/locked/);
    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_dispatch');
    expect(row.action_claim).toBeNull();

    expect((await dispatchStep(order.id, 'pack')).status).toBe(200);
  });

  test('a step pressed out of order is refused with where the order actually is', async () => {
    const order = await verifiedOrder();
    const res = await dispatchStep(order.id, 'pack');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AT_THIS_STEP');
  });

  test('a MedRep cannot do the Dispatch steps (403)', async () => {
    const order = await verifiedOrder();
    expect((await dispatchStep(order.id, 'invoice', {}, medrepToken)).status).toBe(403);
  });
});

describe('Workflow v2 — safety switches on the Dispatch steps', () => {
  test('dry run: the order moves, and nothing at all is sent to Zoho', async () => {
    process.env.ZOHO_DRY_RUN = 'true';
    const order = await verifiedOrder();
    const spies = ['getSalesOrder', 'confirmSalesOrder', 'createInvoiceFromSalesOrder', 'markInvoiceSent', 'createPackageForSalesOrder']
      .map((m) => jest.spyOn(zoho, m));

    const inv = await dispatchStep(order.id, 'invoice');
    expect(inv.status).toBe(200);
    expect(inv.body.data.invoiceNumber).toMatch(/^DRYRUN-INV-/);
    expect((await dispatchStep(order.id, 'pack')).status).toBe(200);

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('picking_packing');
  });

  test('test-customer gate: a customer not on the list is refused before any Zoho call', async () => {
    const order = await verifiedOrder();
    process.env.ZOHO_TEST_CUSTOMER_IDS = 'SOME-OTHER-CONTACT';
    const spies = ['getSalesOrder', 'createInvoiceFromSalesOrder'].map((m) => jest.spyOn(zoho, m));

    const res = await dispatchStep(order.id, 'invoice');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEST_CUSTOMER_ONLY');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.action_claim).toBeNull();
  });
});

describe('Retry never creates a second Sales Order', () => {
  test("an order whose confirm failed already has its Sales Order, so Retry refuses to re-create it", async () => {
    // The shape Verify leaves when Zoho is down: a Zoho id, and 'failed'.
    // An old queue row from a creation that failed and later recovered is
    // exactly what the retry button re-runs.
    const order = await makeOrder({ status: 'ready_for_draft_invoice' });
    await db.prepare("UPDATE orders SET zoho_sync_status = 'failed' WHERE id = ?").run(order.id);
    const now = new Date().toISOString();
    const queued = await db.prepare(`
      INSERT INTO zoho_sync_queue (order_id, payload, status, attempts, last_error, next_attempt_at, created_at, updated_at)
      VALUES (?, '{}', 'succeeded', 1, NULL, ?, ?, ?) RETURNING *
    `).get(order.id, now, now, now);
    const create = jest.spyOn(zoho, 'createSalesOrder');

    const res = await request(app).post(`/api/orders/${order.id}/retry-zoho-sync`).set(as(adminToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_ZOHO');

    const result = await zohoRetryService.processOne(queued);
    expect(result.outcome).toBe('already_in_zoho');

    expect(create).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).zoho_so_id).toBe(order.soId);
  });
});

describe('Workflow v2 — Zoho reporting back our own changes', () => {
  const zohoWebhook = (body) => request(app).post('/api/webhooks/zoho').send(body);

  test("Verify's confirmation and Dispatch's invoice are not logged or notified twice when Zoho reports them", async () => {
    const order = await verifiedOrder();
    const notesAfterVerify = await notificationCount(order.id);

    await zohoWebhook({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: order.soId, status: 'confirmed' } });
    expect(await eventsOf(order.id, 'ZOHO_SO_CONFIRMED')).toHaveLength(1);
    expect(await notificationCount(order.id)).toBe(notesAfterVerify);
    expect((await orderRow(order.id)).status).toBe('ready_for_draft_invoice');

    expect((await dispatchStep(order.id, 'invoice')).status).toBe(200);
    const { zoho_invoice_id: invoiceId, zoho_invoice_number: invoiceNumber } = await orderRow(order.id);
    const notesAfterInvoice = await notificationCount(order.id);

    await zohoWebhook({ event_type: 'invoice.created', invoice: { salesorder_id: order.soId, invoice_id: invoiceId, invoice_number: invoiceNumber, status: 'draft' } });
    await zohoWebhook({ event_type: 'invoice.sent', invoice: { salesorder_id: order.soId, invoice_id: invoiceId, invoice_number: invoiceNumber, status: 'sent' } });
    expect(await eventsOf(order.id, 'ZOHO_INVOICE_SENT')).toHaveLength(1);
    expect(await eventsOf(order.id, 'ZOHO_INVOICE_DRAFTED')).toHaveLength(0);
    expect(await notificationCount(order.id)).toBe(notesAfterInvoice);
    expect((await orderRow(order.id)).status).toBe('ready_for_dispatch');
  });

  test('a webhook that lands while someone is mid-action leaves the recording to that action', async () => {
    const order = await makeOrder({ status: 'ready_for_dispatch' });
    await db.prepare('UPDATE orders SET action_claim = ?, action_claim_at = ? WHERE id = ?')
      .run('Mark packed by Test|x', new Date().toISOString(), order.id);

    await zohoWebhook({ event_type: 'package.created', salesorder: { salesorder_id: order.soId }, package: { package_id: 'PKG-MID-1', salesorder_id: order.soId } });
    expect(await eventsOf(order.id, 'ZOHO_PACKAGE_CREATED')).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe('ready_for_dispatch');
  });

  test('a package report arriving after the shipment does not put the record back to packing', async () => {
    const order = await verifiedOrder();
    expect((await dispatchStep(order.id, 'invoice')).status).toBe(200);
    expect((await dispatchStep(order.id, 'pack')).status).toBe(200);
    expect((await dispatchStep(order.id, 'ship', { courier: 'LBC', trackingNumber: 'TRK-WF2-LATE' })).status).toBe(200);

    await zohoWebhook({ event_type: 'package.created', salesorder: { salesorder_id: order.soId }, package: { package_id: 'PKG-LATE-OTHER', salesorder_id: order.soId } });
    expect((await dispatchRow(order.id)).status).toBe('dispatched');
  });
});
