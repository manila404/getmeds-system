/**
 * Finance confirms, Dispatch works in Getmeds (GETMEDS_WORKFLOW_V2).
 *
 * Sep 12, 2026. Covers services/workflowV2Service.js over real HTTP: the
 * switch, the two Finance outcomes, each Dispatch step, and the safety rails
 * the build plan (field guide, chapter 12) asked for — one Zoho write when two
 * people press the same button, adopting what someone already made in Zoho,
 * stopping on a voided Sales Order, dry run and the test-customer gate, and
 * Zoho's report of our own change not being logged or notified twice.
 *
 * Runs against the in-memory mock Zoho (tests/setupEnv.js forces it). The
 * switch and the two safety flags are read per request, so each test sets
 * them for itself and they are restored afterwards.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

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
let customerId;
let medrepId;
let seq = 0;
const savedEnv = {};

/** A Getmeds order sitting at `status`, with a real (mock) draft Sales Order behind it. */
async function makeOrder({ status = 'so_created' } = {}) {
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
const confirm = (id, body = { approved: true, pricesChecked: true, proofChecked: true }, token = financeToken) =>
  request(app).post(`/api/finance/orders/${id}/confirm`).set(as(token)).send(body);
const dispatchStep = (id, step, body = {}, token = dispatchToken) =>
  request(app).post(`/api/dispatch/orders/${id}/${step}`).set(as(token)).send(body);

const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const dispatchRow = (id) => db.prepare('SELECT * FROM dispatch_records WHERE order_id = ?').get(id);
const eventsOf = (id, type) => db.prepare('SELECT * FROM order_events WHERE order_id = ? AND event_type = ? ORDER BY id').all(id, type);
const notificationCount = async (id) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE order_id = ?').get(id)).n);

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
  customerId = (await db.prepare(`SELECT id FROM customers WHERE zoho_contact_id = 'FIXTURE-CONTACT-1'`).get()).id;
  medrepId = (await db.prepare(`SELECT id FROM users WHERE email = 'medrep@getmeds.ph'`).get()).id;
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
  const mine = `SELECT id FROM orders WHERE getmeds_order_id LIKE 'WF2-%'`;
  await db.prepare(`DELETE FROM notifications WHERE order_id IN (${mine})`).run();
  await db.prepare(`DELETE FROM order_events WHERE order_id IN (${mine})`).run();
  await db.prepare(`DELETE FROM dispatch_records WHERE order_id IN (${mine})`).run();
  await db.prepare(`DELETE FROM orders WHERE getmeds_order_id LIKE 'WF2-%'`).run();
});

describe('Workflow v2 — the switch', () => {
  test('switched off, every new action answers 404 FEATURE_OFF and nothing reaches Zoho', async () => {
    process.env.GETMEDS_WORKFLOW_V2 = 'false';
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'markSalesOrderConfirmed');

    const res = await confirm(order.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_OFF');

    for (const step of ['invoice', 'pack', 'ship', 'deliver']) {
      const r = await dispatchStep(order.id, step);
      expect(r.status).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('so_created');
  });

  test('switched off, the queues report it and keep their old shape', async () => {
    process.env.GETMEDS_WORKFLOW_V2 = 'false';
    const fin = await request(app).get('/api/finance/queue').set(as(financeToken));
    expect(fin.body.data.workflow_v2).toBe(false);
    const dis = await request(app).get('/api/dispatch/queue').set(as(dispatchToken));
    expect(dis.body.data.workflow_v2).toBe(false);
  });
});

describe('Workflow v2 — Finance', () => {
  test('a draft Sales Order is Finance\'s to confirm: it shows in their actionable list', async () => {
    const order = await makeOrder();
    const res = await request(app).get('/api/finance/queue?stage=actionable&limit=100').set(as(financeToken));
    expect(res.status).toBe(200);
    expect(res.body.data.workflow_v2).toBe(true);
    expect(res.body.data.orders.map((o) => o.id)).toContain(order.id);
  });

  test('Confirm order needs both checks ticked', async () => {
    const order = await makeOrder();
    const res = await confirm(order.id, { approved: true, pricesChecked: true, proofChecked: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKS_REQUIRED');
    expect((await orderRow(order.id)).status).toBe('so_created');
  });

  test('Confirm order confirms the Sales Order in Zoho and hands the order to Dispatch', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'markSalesOrderConfirmed');

    const res = await confirm(order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready_for_draft_invoice');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(order.soId);
    expect((await zoho.getSalesOrder(order.soId)).salesorder.status).toBe('confirmed');

    const row = await orderRow(order.id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.zoho_so_status).toBe('confirmed');
    expect(row.action_claim).toBeNull();

    const confirmed = await eventsOf(order.id, 'ZOHO_SO_CONFIRMED');
    expect(confirmed).toHaveLength(1);
    expect(JSON.parse(confirmed[0].metadata)).toEqual(expect.objectContaining({ source: 'getmeds', zohoSoId: order.soId }));
    expect(await eventsOf(order.id, 'FINANCE_VERIFIED')).toHaveLength(1);
  });

  test('two people pressing Confirm order at once make ONE Zoho call', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'markSalesOrderConfirmed');

    const [a, b] = await Promise.all([confirm(order.id), confirm(order.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['ALREADY_IN_PROGRESS', 'NOT_AT_THIS_STEP']).toContain(loser.body.error.code);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await eventsOf(order.id, 'ZOHO_SO_CONFIRMED')).toHaveLength(1);
  });

  test('Hold needs a reason, and with one puts the order on hold without touching Zoho', async () => {
    const order = await makeOrder();
    const spy = jest.spyOn(zoho, 'getSalesOrder');

    const missing = await confirm(order.id, { approved: false });
    expect(missing.status).toBe(400);

    const res = await confirm(order.id, { approved: false, reason: 'Prices on line 1 do not match the quotation' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('on_hold');
    expect(spy).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('on_hold');
    expect(row.exception_reason).toMatch(/quotation/);
  });

  test('a MedRep can do neither the Finance nor the Dispatch steps (403)', async () => {
    const order = await makeOrder();
    expect((await confirm(order.id, undefined, medrepToken)).status).toBe(403);
    expect((await dispatchStep(order.id, 'invoice', {}, medrepToken)).status).toBe(403);
  });

  test('a Sales Order voided in Zoho stops the step, and the order is left as it was', async () => {
    const order = await makeOrder();
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
      code: 0,
      salesorder: { salesorder_id: order.soId, salesorder_number: 'SO-VOID', status: 'void' }
    });
    const write = jest.spyOn(zoho, 'markSalesOrderConfirmed');

    const res = await confirm(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOIDED_IN_ZOHO');
    expect(write).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('so_created');
    expect(row.action_claim).toBeNull();
  });

  test('Zoho refusing the write comes back as a clear 502, and the order can be tried again', async () => {
    const order = await makeOrder();
    jest.spyOn(zoho, 'markSalesOrderConfirmed').mockRejectedValueOnce(new Error('This Sales Order is locked'));

    const res = await confirm(order.id);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ZOHO_WRITE_FAILED');
    expect(res.body.error.message).toMatch(/locked/);
    const row = await orderRow(order.id);
    expect(row.status).toBe('so_created');
    expect(row.action_claim).toBeNull();

    expect((await confirm(order.id)).status).toBe(200);
  });
});

describe('Workflow v2 — Dispatch', () => {
  test('invoice → pack → ship → deliver, each step writing to Zoho once', async () => {
    const order = await makeOrder();
    expect((await confirm(order.id)).status).toBe(200);

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

  test('an invoice someone already made in Zoho is recorded, not made a second time', async () => {
    const order = await makeOrder();
    expect((await confirm(order.id)).status).toBe(200);
    const so = (await zoho.getSalesOrder(order.soId)).salesorder;
    const { invoice } = await zoho.createInvoiceFromSalesOrder(so);

    const spy = jest.spyOn(zoho, 'createInvoiceFromSalesOrder');
    const res = await dispatchStep(order.id, 'invoice');
    expect(res.status).toBe(200);
    expect(res.body.data.adopted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).zoho_invoice_id).toBe(invoice.invoice_id);
  });

  test('a step pressed out of order is refused with where the order actually is', async () => {
    const order = await makeOrder();
    const res = await dispatchStep(order.id, 'pack');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AT_THIS_STEP');
  });
});

describe('Workflow v2 — safety switches', () => {
  test('dry run: the order moves, and nothing at all is sent to Zoho', async () => {
    process.env.ZOHO_DRY_RUN = 'true';
    const order = await makeOrder();
    const spies = ['getSalesOrder', 'markSalesOrderConfirmed', 'createInvoiceFromSalesOrder', 'markInvoiceSent']
      .map((m) => jest.spyOn(zoho, m));

    const c = await confirm(order.id);
    expect(c.status).toBe(200);
    expect(c.body.data.dryRun).toBe(true);
    const inv = await dispatchStep(order.id, 'invoice');
    expect(inv.status).toBe(200);
    expect(inv.body.data.invoiceNumber).toMatch(/^DRYRUN-INV-/);

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).status).toBe('ready_for_dispatch');
  });

  test('test-customer gate: a customer not on the list is refused before any Zoho call', async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = 'SOME-OTHER-CONTACT';
    const order = await makeOrder();
    const spies = ['getSalesOrder', 'markSalesOrderConfirmed'].map((m) => jest.spyOn(zoho, m));

    const res = await confirm(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEST_CUSTOMER_ONLY');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const row = await orderRow(order.id);
    expect(row.status).toBe('so_created');
    expect(row.action_claim).toBeNull();
  });
});

describe('Workflow v2 — Zoho reporting back our own changes', () => {
  const zohoWebhook = (body) => request(app).post('/api/webhooks/zoho').send(body);

  test('the Sales Order and invoice webhooks for a change made here are not logged or notified twice', async () => {
    const order = await makeOrder();
    expect((await confirm(order.id)).status).toBe(200);
    const notesAfterConfirm = await notificationCount(order.id);

    await zohoWebhook({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: order.soId, status: 'confirmed' } });
    expect(await eventsOf(order.id, 'ZOHO_SO_CONFIRMED')).toHaveLength(1);
    expect(await notificationCount(order.id)).toBe(notesAfterConfirm);
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
    const order = await makeOrder();
    expect((await confirm(order.id)).status).toBe(200);
    expect((await dispatchStep(order.id, 'invoice')).status).toBe(200);
    expect((await dispatchStep(order.id, 'pack')).status).toBe(200);
    expect((await dispatchStep(order.id, 'ship', { courier: 'LBC', trackingNumber: 'TRK-WF2-LATE' })).status).toBe(200);

    await zohoWebhook({ event_type: 'package.created', salesorder: { salesorder_id: order.soId }, package: { package_id: 'PKG-LATE-OTHER', salesorder_id: order.soId } });
    expect((await dispatchRow(order.id)).status).toBe('dispatched');
  });
});
