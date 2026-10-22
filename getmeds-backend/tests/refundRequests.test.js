/**
 * Refund requests for orders already paid for and in Zoho (Oct 22, 2026; reworked Oct 23, 2026 after Finance: "there is no void").
 *
 *   draft     MedRep asks -> Management approves -> order cancelled, on Finance's list
 *   payment   Sales Order / invoice, goods not coming back: Management approves -> on Finance's list;
 *             Finance records the customer's payment in Zoho first, refunds it there, then records it here
 *   return    shipped and coming back: Management approves -> Dispatch checks the goods (good / damaged) -> Management
 *             presses Refund -> Finance's credit note must exist in Zoho -> Finance refunds and records it here
 *
 * The app only READS Zoho: getSalesOrder / getInvoice / findCreditNotes are stubbed here to play "what Zoho says now".
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
  let medrep, medrep2, manager, finance, dispatch;
  let medrepId, customerId;
  const created = [];

  beforeAll(async () => {
    [medrep, medrep2, manager, finance, dispatch] = await Promise.all([
      loginAs('medrep@getmeds.ph'), loginAs('medrep2@getmeds.ph'), loginAs('manager@getmeds.ph'),
      loginAs('finance@getmeds.ph'), loginAs('dispatch@getmeds.ph')
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

  /** Play "what Zoho says" about the invoice. */
  const zohoSays = (o, { invStatus = 'sent', balance, total = 3589 } = {}) => {
    jest.spyOn(zoho, 'getInvoice').mockRejectedValue(new Error('not stubbed')); // falls back to the Sales Order's list
    return jest.spyOn(zoho, 'getSalesOrder').mockImplementation(async () => ({
      code: 0,
      salesorder: {
        salesorder_id: o.zoho_so_id, status: 'open',
        invoices: o.zoho_invoice_id ? [{ invoice_id: o.zoho_invoice_id, invoice_number: o.zoho_invoice_number, status: invStatus, total, balance: balance === undefined ? total : balance }] : []
      }
    }));
  };
  /** Play "the credit notes in Zoho". */
  const creditNotes = (list) => jest.spyOn(zoho, 'findCreditNotes').mockImplementation(async () => ({ code: 0, creditnotes: list }));

  const post = (path, token, body = {}) => request(app).post(`/api/refund-requests${path}`).set(auth(token)).send(body);
  const get = (path, token) => request(app).get(`/api/refund-requests${path}`).set(auth(token));
  const ask = (o, body = {}, token = medrep) => post('', token, { order_id: o.id, reason: 'Customer cancelled', goods_status: 'not_shipped', ...body });
  const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const reqRow = (id) => db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(id);
  const financeList = async (status = 'pending') => (await request(app).get('/api/finance/refunds').query({ status }).set(auth(finance))).body.data.refunds;
  const record = (o, amount) => request(app).post(`/api/orders/${o.id}/refund`).set(auth(finance)).send({ status: 'done', refund_amount: amount, reference: 'BPI 1', refund_date: '2026-10-23' });

  describe('draft', () => {
    test('asks, Management approves, the order is cancelled and Finance records the refund (no Zoho step)', async () => {
      const o = await order({ status: 'draft' });
      const res = await ask(o, { goods_status: undefined });
      expect(res.status).toBe(200);
      const id = res.body.data.request.id;
      expect(res.body.data.request).toMatchObject({ stage: 'draft', status: 'requested', goods_status: 'not_shipped', path: 'draft' });

      const ok = await post(`/${id}/approve`, manager);
      expect(ok.status).toBe(200);
      expect(ok.body.data.request).toMatchObject({ status: 'queued', next: 'finance_refund' });
      const after = await orderRow(o.id);
      expect(after).toMatchObject({ status: 'cancelled', refund_status: 'pending', draft_cancel_kind: 'keep_record' });
      expect(Number(after.refund_received_amount)).toBe(3589);
      expect((await financeList()).find((r) => r.id === o.id)).toMatchObject({ source_stage: 'draft' });

      expect((await record(o, 3589)).status).toBe(200);
      expect((await reqRow(id)).status).toBe('done');
    });
  });

  describe('payment path (goods not coming back)', () => {
    test('Sales Order, not shipped: Finance records the payment first, then the refund', async () => {
      const o = await order({ status: 'ready_for_draft_invoice', so: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;

      const ap = await post(`/${id}/approve`, manager);
      expect(ap.body.data.request).toMatchObject({ status: 'queued', path: 'payment', next: 'finance_payment' });
      expect((await orderRow(o.id)).refund_status).toBe('pending');
      expect((await get('/finance-steps', finance)).body.data.requests.map((r) => r.id)).toContain(id);

      // The refund cannot be recorded before the payment is in Zoho.
      const early = await record(o, 3589);
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('PAYMENT_NOT_CONFIRMED');
      expect((await reqRow(id)).status).toBe('queued');

      expect((await post(`/${id}/payment-recorded`, finance)).status).toBe(200);
      expect((await get('/finance-steps', finance)).body.data.requests.map((r) => r.id)).not.toContain(id);
      expect((await record(o, 3589)).status).toBe(200);
      expect((await reqRow(id)).status).toBe('done');
    });

    test('invoiced and unpaid in Zoho: Finance cannot confirm until Zoho shows the payment', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'customer_keeps', amount: 1000 })).body.data.request.id;
      zohoSays(o, { invStatus: 'sent' });
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.body.data.request).toMatchObject({ status: 'queued', next: 'finance_payment', requested_amount: 1000 });

      const no = await post(`/${id}/payment-recorded`, finance);
      expect(no.status).toBe(409);
      expect(no.body.error.code).toBe('PAYMENT_NOT_IN_ZOHO');

      zohoSays(o, { invStatus: 'paid', balance: 0 }); // Finance recorded it in Zoho
      const ok = await post(`/${id}/payment-recorded`, finance);
      expect(ok.status).toBe(200);
      expect(ok.body.data.request.next).toBe('finance_refund');
      expect((await record(o, 1000)).status).toBe(200);
    });

    test('invoice already paid in Zoho when Management approves: the payment step is already done', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      zohoSays(o, { invStatus: 'paid', balance: 0 });
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.body.data.request).toMatchObject({ status: 'queued', next: 'finance_refund' });
      expect(ap.body.data.request.payment_recorded_at).toBeTruthy();
    });

    test('if Zoho cannot be read at approval, the step is left for Finance', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'not_shipped' })).body.data.request.id;
      jest.spyOn(zoho, 'getInvoice').mockRejectedValue(new Error('timeout'));
      jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('timeout'));
      const ap = await post(`/${id}/approve`, manager);
      expect(ap.status).toBe(200);
      expect(ap.body.data.request).toMatchObject({ status: 'queued', next: 'finance_payment' });
      expect((await post(`/${id}/payment-recorded`, finance)).body.error.code).toBe('ZOHO_UNREADABLE');
    });
  });

  describe('return path (shipped, coming back)', () => {
    test('Dispatch checks the goods, Management presses Refund, Finance\'s credit note must exist in Zoho', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'returning' })).body.data.request.id;

      // Dispatch sees a heads-up while Management decides, work once approved.
      let rc = (await get('/return-checks', dispatch)).body.data;
      expect(rc.upcoming.map((r) => r.id)).toContain(id);
      expect(rc.requests.map((r) => r.id)).not.toContain(id);

      const ap = await post(`/${id}/approve`, manager);
      expect(ap.body.data.request).toMatchObject({ status: 'approved', path: 'return', next: 'dispatch_goods' });
      expect((await orderRow(o.id)).status).toBe('tracking_shared'); // nothing cancelled yet
      rc = (await get('/return-checks', dispatch)).body.data;
      expect(rc.requests.map((r) => r.id)).toContain(id);
      expect(rc.upcoming.map((r) => r.id)).not.toContain(id);

      // Management cannot press Refund before Dispatch has checked the goods.
      expect((await post(`/${id}/refund`, manager)).body.error.code).toBe('NOT_READY');

      // Dispatch: a condition is required; damaged needs a note.
      expect((await post(`/${id}/goods-checked`, dispatch, {})).status).toBe(400);
      expect((await post(`/${id}/goods-checked`, dispatch, { condition: 'damaged' })).status).toBe(400);
      const ck = await post(`/${id}/goods-checked`, dispatch, { condition: 'good', note: 'Sealed, in date' });
      expect(ck.status).toBe(200);
      expect(ck.body.data.request).toMatchObject({ status: 'returned', goods_condition: 'good', next: 'management_refund' });
      expect((await get('/return-checks', dispatch)).body.data.requests.map((r) => r.id)).not.toContain(id);

      const q = await post(`/${id}/refund`, manager);
      expect(q.status).toBe(200);
      expect(q.body.data.request).toMatchObject({ status: 'queued', next: 'finance_credit_note' });
      expect(await orderRow(o.id)).toMatchObject({ status: 'cancelled', refund_status: 'pending' });
      expect((await financeList()).find((r) => r.id === o.id)).toMatchObject({ source_stage: 'invoiced' });

      // Finance: no credit note in Zoho yet, then a wrong one, then the right one.
      expect((await record(o, 3589)).body.error.code).toBe('CREDIT_NOTE_NOT_CONFIRMED');
      creditNotes([]);
      expect((await post(`/${id}/credit-note-check`, finance)).body.error.code).toBe('NO_CREDIT_NOTE');
      creditNotes([{ creditnote_number: 'CN-1', status: 'draft', total: 3589 }]);
      expect((await post(`/${id}/credit-note-check`, finance)).body.error.code).toBe('NO_CREDIT_NOTE'); // a draft does not count
      creditNotes([{ creditnote_number: 'CN-1', status: 'open', total: 2000 }]);
      expect((await post(`/${id}/credit-note-check`, finance)).body.error.code).toBe('CREDIT_NOTE_AMOUNT');
      const spy = creditNotes([{ creditnote_number: 'CN-2', status: 'open', total: 3589 }]);
      const ok = await post(`/${id}/credit-note-check`, finance);
      expect(ok.status).toBe(200);
      expect(ok.body.data.request).toMatchObject({ credit_note_number: 'CN-2', next: 'finance_refund' });
      expect(spy).toHaveBeenCalledWith({ reference_number: o.zoho_invoice_number }); // searched by the invoice it was raised against

      expect((await record(o, 3589)).status).toBe(200);
      expect((await reqRow(id)).status).toBe('done');
      const events = (await db.prepare('SELECT event_type FROM order_events WHERE order_id = ? ORDER BY id').all(o.id)).map((e) => e.event_type);
      expect(events).toEqual(expect.arrayContaining(['REFUND_REQUESTED', 'REFUND_REQUEST_APPROVED', 'GOODS_RETURNED', 'REFUND_QUEUED', 'CREDIT_NOTE_CONFIRMED']));
    });

    test('Finance can name the credit note, and one belonging to another customer is refused', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      await db.prepare("UPDATE customers SET zoho_contact_id = 'ZC-1' WHERE id = ?").run(customerId);
      const id = (await ask(o, { goods_status: 'customer_returns' })).body.data.request.id;
      await post(`/${id}/approve`, manager);
      await post(`/${id}/goods-checked`, dispatch, { condition: 'good' });
      await post(`/${id}/refund`, manager);

      const spy = creditNotes([{ creditnote_number: 'CN-9', status: 'open', total: 3589, customer_id: 'ZC-OTHER' }]);
      expect((await post(`/${id}/credit-note-check`, finance, { number: 'CN-9' })).body.error.code).toBe('WRONG_CUSTOMER');
      expect(spy).toHaveBeenCalledWith({ creditnote_number: 'CN-9' });
      creditNotes([{ creditnote_number: 'CN-9', status: 'open', total: 3589, customer_id: 'ZC-1' }]);
      expect((await post(`/${id}/credit-note-check`, finance, { number: 'CN-9' })).status).toBe(200);
      await db.prepare('UPDATE customers SET zoho_contact_id = NULL WHERE id = ?').run(customerId);
    });

    test('damaged goods: Management can reject instead of refunding', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'returning' })).body.data.request.id;
      await post(`/${id}/approve`, manager);
      const ck = await post(`/${id}/goods-checked`, dispatch, { condition: 'damaged', note: 'Box crushed, seals broken' });
      expect(ck.body.data.request).toMatchObject({ status: 'returned', goods_condition: 'damaged' });
      expect((await post(`/${id}/reject`, manager, { note: 'Not resellable, talk to the customer' })).status).toBe(200);
      expect((await reqRow(id)).status).toBe('rejected');
      expect((await orderRow(o.id)).status).toBe('tracking_shared');
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
      expect((await ask(a)).status).toBe(200); // withdrawn: a new one can be raised

      const b = await order({ status: 'ready_for_dispatch', so: true });
      const idb = (await ask(b)).body.data.request.id;
      expect((await post(`/${idb}/reject`, manager, {})).status).toBe(400);
      expect((await post(`/${idb}/reject`, manager, { note: 'Already shipped and delivered' })).status).toBe(200);
      expect((await orderRow(b.id)).status).toBe('ready_for_dispatch');
      const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ? ORDER BY id DESC LIMIT 1').get(b.id, medrepId);
      expect(note.message).toMatch(/Already shipped/);
    });

    test('each role only does its own step', async () => {
      const o = await order({ status: 'tracking_shared', so: true, invoiced: true });
      const id = (await ask(o, { goods_status: 'returning' })).body.data.request.id;
      for (const t of [medrep, finance, dispatch]) expect((await post(`/${id}/approve`, t)).status).toBe(403);
      expect((await post(`/${id}/goods-checked`, finance, { condition: 'good' })).status).toBe(403);
      expect((await post(`/${id}/payment-recorded`, dispatch)).status).toBe(403);
      expect((await post(`/${id}/credit-note-check`, dispatch)).status).toBe(403);
      expect((await post(`/${id}/refund`, medrep)).status).toBe(403);
      expect((await post(`/${id}/goods-checked`, dispatch, { condition: 'good' })).status).toBe(409); // not approved yet
    });

    test('a cancelled order has nothing to refund', async () => {
      const o = await order({ status: 'cancelled' });
      expect((await ask(o)).body.error.code).toBe('NOT_REFUNDABLE');
    });

    test('the order page carries the request', async () => {
      const o = await order({ status: 'ready_for_dispatch', so: true });
      await ask(o);
      const res = await request(app).get(`/api/orders/${o.id}`).set(auth(medrep));
      expect(res.body.data.order.refund_request).toMatchObject({ status: 'requested', stage: 'so', next: 'management_decision' });
    });
  });
});
