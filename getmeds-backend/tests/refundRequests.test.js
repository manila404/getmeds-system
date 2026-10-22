/**
 * Refund requests for orders already paid for and in Zoho (Oct 22, 2026).
 *
 *   draft     MedRep asks -> Management approves -> order cancelled, on Finance's list
 *   so        same, and Dispatch confirms the Sales Order is closed in Zoho (never holds the refund up)
 *   invoiced  MedRep asks -> Management approves -> Finance removes the payment -> Dispatch records the goods
 *             returned and voids the invoice IN ZOHO -> the app checks -> Management presses Refund
 *
 * The app only READS Zoho: getSalesOrder is stubbed here to play "what Zoho says now".
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('refund requests', () => {
  let medrep, medrep2, manager, finance, dispatch, admin;
  let medrepId, customerId;
  const created = [];

  beforeAll(async () => {
    [medrep, medrep2, manager, finance, dispatch, admin] = await Promise.all([
      loginAs('medrep@getmeds.ph'), loginAs('medrep2@getmeds.ph'), loginAs('manager@getmeds.ph'),
      loginAs('finance@getmeds.ph'), loginAs('dispatch@getmeds.ph'), loginAs('admin@getmeds.ph')
    ]);
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id); // refund_requests go with it (ON DELETE CASCADE)
    }
  });
  afterEach(() => jest.restoreAllMocks());

  async function order({ status = 'ready_for_dispatch', so = false, invoiced = false, total = 3589 } = {}) {
    const ref = `GM-RFND-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db.prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address,
                           zoho_so_id, zoho_so_number, zoho_invoice_id, zoho_invoice_number)
       VALUES (?, ?, ?, ?, 'credit', ?, '1 Refund St', ?, ?, ?, ?)`
    ).run(ref, customerId, medrepId, status, total, so ? `ZSO-${ref}` : null, so ? `SO-${ref.slice(-4)}` : null, invoiced ? `ZINV-${ref}` : null, invoiced ? `INV-${ref.slice(-4)}` : null);
    const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(row.id);
    return row;
  }

  /** Play "what Zoho says": the invoice's state and the Sales Order's. */
  const zohoSays = (o, { invStatus = 'sent', balance, total = 3589, soStatus = 'open' } = {}) =>
    jest.spyOn(zoho, 'getSalesOrder').mockImplementation(async () => ({
      code: 0,
      salesorder: {
        salesorder_id: o.zoho_so_id, status: soStatus,
        invoices: o.zoho_invoice_id ? [{ invoice_id: o.zoho_invoice_id, invoice_number: o.zoho_invoice_number, status: invStatus, total, balance: balance === undefined ? total : balance }] : []
      }
    }));

  const post = (path, token, body = {}) => request(app).post(`/api/refund-requests${path}`).set(auth(token)).send(body);
  const ask = (o, body = {}, token = medrep) => post('', token, { order_id: o.id, reason: 'Customer cancelled', goods_status: 'not_shipped', ...body });
  const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const reqRow = (id) => db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(id);
  const financeList = async (status = 'pending') => (await request(app).get('/api/finance/refunds').query({ status }).set(auth(finance))).body.data.refunds;

  describe('case A: a draft', () => {
    test('asks, Management approves, the order is cancelled and Finance records the refund', async () => {
      const o = await order({ status: 'draft' });
      const res = await ask(o, { goods_status: undefined });
      expect(res.status).toBe(200);
      const id = res.body.data.request.id;
      expect(res.body.data.request).toMatchObject({ stage: 'draft', status: 'requested', goods_status: 'not_shipped' });

      const ok = await post(`/${id}/approve`, manager);
      expect(ok.status).toBe(200);
      expect(ok.body.data.request.status).toBe('queued');
      const after = await orderRow(o.id);
      expect(after).toMatchObject({ status: 'cancelled', refund_status: 'pending', draft_cancel_kind: 'keep_record' });
      expect(Number(after.refund_received_amount)).toBe(3589);

      const row = (await financeList()).find((r) => r.id === o.id);
      expect(row).toMatchObject({ source_stage: 'draft' });

      const rec = await request(app).post(`/api/orders/${o.id}/refund`).set(auth(finance)).send({ status: 'done', refund_amount: 3589, reference: 'BPI 1', refund_date: '2026-10-23' });
      expect(rec.status).toBe(200);
      expect((await reqRow(id)).status).toBe('done');
    });
  });

  describe('case B: a Sales Order, not invoiced', () => {
    test('approval goes straight to Finance; Dispatch confirms the Sales Order is closed, and that never blocks it', async () => {
      const o = await order({ status: 'ready_for_draft_invoice', so: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      expect((await post(`/${id}/approve`, manager)).body.data.request.status).toBe('queued');
      expect((await orderRow(o.id)).refund_status).toBe('pending');

      zohoSays(o, { soStatus: 'open' });
      const early = await post(`/${id}/check-so`, dispatch);
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('SO_STILL_OPEN');
      zohoSays(o, { soStatus: 'void' });
      const done = await post(`/${id}/check-so`, dispatch);
      expect(done.status).toBe(200);
      expect(done.body.data.request.so_closed_at).toBeTruthy();
    });
  });

  describe('case C: invoiced', () => {
    test('payment removed, goods returned, invoice voided in Zoho, then Management presses Refund', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'returning' })).body.data.request.id;

      zohoSays(o, { invStatus: 'paid', balance: 0 });
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.status).toBe(200);
      expect(ap.body.data.request).toMatchObject({ status: 'approved', payment_applied: true, next: 'finance_payment' });
      expect((await orderRow(o.id)).status).toBe('tracking_shared'); // nothing cancelled yet

      // Dispatch is held back: goods first, then the payment.
      expect((await post(`/${id}/check-void`, dispatch)).body.error.code).toBe('GOODS_NOT_RECORDED');
      expect((await post(`/${id}/goods-returned`, dispatch, { note: 'Back at the warehouse' })).status).toBe(200);
      expect((await post(`/${id}/check-void`, dispatch)).body.error.code).toBe('PAYMENT_STILL_APPLIED');

      // Finance cannot say it is removed while Zoho still shows it.
      expect((await post(`/${id}/payment-removed`, finance)).body.error.code).toBe('PAYMENT_STILL_APPLIED');
      expect((await request(app).get('/api/refund-requests/payments-to-remove').set(auth(finance))).body.data.requests.map((r) => r.id)).toContain(id);

      zohoSays(o, { invStatus: 'sent' }); // Finance removed it in Zoho
      expect((await post(`/${id}/payment-removed`, finance)).status).toBe(200);
      expect((await request(app).get('/api/refund-requests/payments-to-remove').set(auth(finance))).body.data.requests.map((r) => r.id)).not.toContain(id);

      // Not void yet: the app refuses to move on.
      const early = await post(`/${id}/check-void`, dispatch);
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('NOT_VOID_YET');
      expect((await post(`/${id}/refund`, manager)).status).toBe(409); // Refund waits for the void

      zohoSays(o, { invStatus: 'void' }); // Dispatch voided it in Zoho
      const ok = await post(`/${id}/check-void`, dispatch);
      expect(ok.status).toBe(200);
      expect(ok.body.data.request.status).toBe('voided');

      const q = await post(`/${id}/refund`, manager);
      expect(q.status).toBe(200);
      expect(q.body.data.request.status).toBe('queued');
      expect(await orderRow(o.id)).toMatchObject({ status: 'cancelled', refund_status: 'pending' });
      expect((await financeList()).find((r) => r.id === o.id)).toMatchObject({ source_stage: 'invoiced' });

      const events = (await db.prepare('SELECT event_type FROM order_events WHERE order_id = ? ORDER BY id').all(o.id)).map((e) => e.event_type);
      expect(events).toEqual(expect.arrayContaining(['REFUND_REQUESTED', 'REFUND_REQUEST_APPROVED', 'GOODS_RETURNED', 'PAYMENT_REMOVED', 'INVOICE_VOIDED', 'REFUND_QUEUED']));
    });

    test('an unpaid invoice skips the payment step, and the customer keeping the goods skips the goods step', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'customer_keeps', amount: 1000 })).body.data.request.id;
      zohoSays(o, { invStatus: 'overdue' });
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.body.data.request).toMatchObject({ status: 'approved', payment_applied: false, next: 'dispatch_void', requested_amount: 1000 });
      expect((await post(`/${id}/goods-returned`, dispatch)).body.error.code).toBe('NOT_NEEDED');
      zohoSays(o, { invStatus: 'void' });
      expect((await post(`/${id}/check-void`, dispatch)).body.data.request.status).toBe('voided');
    });

    test('an invoice already void in Zoho goes straight to "ready to refund"', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      zohoSays(o, { invStatus: 'void' });
      expect((await post(`/${id}/approve`, manager)).body.data.request.status).toBe('voided');
    });

    test('if Zoho cannot be read the approval still goes through and says so in the trail', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('timeout'));
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.status).toBe(200);
      expect(ap.body.data.request).toMatchObject({ status: 'approved', payment_applied: null });
      const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'REFUND_REQUEST_APPROVED'").get(o.id);
      expect(ev.notes).toMatch(/could not be read/i);
    });
  });

  describe('rules', () => {
    test('one open request per order, and who may ask', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true });
      expect((await ask(o)).status).toBe(200);
      expect((await ask(o)).body.error.code).toBe('ALREADY_REQUESTED');
      const other = await order({ status: 'ready_for_dispatch', so: true });
      expect((await ask(other, {}, medrep2)).status).toBe(403); // not their order
      expect((await ask(other, {}, finance)).status).toBe(403); // Finance does not ask
    });

    test('needs a reason, where the goods are, and an amount that is not more than the total', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, total: 500 });
      expect((await ask(o, { reason: '  ' })).status).toBe(400);
      expect((await ask(o, { goods_status: 'somewhere' })).status).toBe(400);
      expect((await ask(o, { amount: 501 })).status).toBe(400);
      expect((await ask(o, { amount: 500 })).status).toBe(200);
    });

    test('withdraw before Management decides, not after; reject needs a note and tells the requester', async () => {
      const a = await order({ status: 'ready_for_dispatch', so: true });
      const ida = (await ask(a)).body.data.request.id;
      expect((await post(`/${ida}/withdraw`, medrep2)).status).toBe(403);
      expect((await post(`/${ida}/withdraw`, medrep)).status).toBe(200);
      expect((await post(`/${ida}/approve`, manager)).status).toBe(409);
      // withdrawn: a new one can be raised
      expect((await ask(a)).status).toBe(200);

      const b = await order({ status: 'ready_for_dispatch', so: true });
      const idb = (await ask(b)).body.data.request.id;
      expect((await post(`/${idb}/reject`, manager, {})).status).toBe(400);
      expect((await post(`/${idb}/reject`, manager, { note: 'Already shipped and delivered' })).status).toBe(200);
      expect((await orderRow(b.id)).status).toBe('ready_for_dispatch');
      const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ? ORDER BY id DESC LIMIT 1').get(b.id, medrepId);
      expect(note.message).toMatch(/Already shipped/);
    });

    test('only Management decides; Dispatch and Finance only do their own step', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      for (const t of [medrep, finance, dispatch]) expect((await post(`/${id}/approve`, t)).status).toBe(403);
      expect((await post(`/${id}/payment-removed`, dispatch)).status).toBe(403);
      expect((await post(`/${id}/check-void`, finance)).status).toBe(403);
      expect((await post(`/${id}/refund`, medrep)).status).toBe(403);
    });

    test('a cancelled order has nothing to refund', async () => {
      const o = await order({ status: 'cancelled' });
      expect((await ask(o)).body.error.code).toBe('NOT_REFUNDABLE');
    });

    test('Dispatch sees a request that is still waiting for Management as a heads-up, and as work once approved', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'returning' })).body.data.request.id;
      const vr = async () => (await request(app).get('/api/refund-requests/void-requests').set(auth(dispatch))).body.data;
      let d = await vr();
      expect(d.upcoming.map((r) => r.id)).toContain(id);
      expect(d.requests.map((r) => r.id)).not.toContain(id);
      zohoSays(o, { invStatus: 'sent' });
      await post(`/${id}/approve`, manager);
      d = await vr();
      expect(d.requests.map((r) => r.id)).toContain(id);
      expect(d.upcoming.map((r) => r.id)).not.toContain(id);
    });

    test('the order page carries the request', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true });
      await ask(o);
      const res = await request(app).get(`/api/orders/${o.id}`).set(auth(medrep));
      expect(res.body.data.order.refund_request).toMatchObject({ status: 'requested', stage: 'so', next: 'management_decision' });
    });
  });
});
