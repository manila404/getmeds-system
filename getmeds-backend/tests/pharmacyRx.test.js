/**
 * Sep 25, 2026 — Pharmacy: prescription verification, in parallel with Finance.
 *
 * What is pinned here:
 *   - the state an order's prescription is in, including the two easy-to-get-
 *     wrong cases: a rejection the MedRep has answered stops counting, and a
 *     rejected page of a multi-page prescription is NOT cleared by another page
 *     that was already there
 *   - early visibility: an order with a prescription is in the pharmacy queue
 *     BEFORE Finance confirms it, and one still awaiting Management is not
 *   - verify / reject, and who may
 *   - the gate: an unverified prescription blocks confirming for delivery and
 *     adding tracking, and does not block a parcel that has already shipped
 *   - the badges on the Dispatch board
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { summarize, rxBadge } = require('../src/services/prescriptionService');

const created = [];
let dispatchToken, managementToken, medrepToken, adminToken;
let medrepId, dispatchId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function orderAt(status, { prefix = 'GM-RX', zohoSoId = `ZSO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } = {}) {
  const ref = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, intake_receiver, intake_contact_no, zoho_so_id, zoho_so_number)
       VALUES (?, ?, ?, ?, 'credit', 900, '1 Rx St, Cebu', 'Receiver', '0917 000 0000', ?, 'SO-RX')`
    )
    .run(ref, customerId, medrepId, status, zohoSoId);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  return row;
}

let tick = 0;
async function addRx(orderId, { status = 'pending', name = 'rx.jpg', uploadedAt, verifiedAt = null, reason = null } = {}) {
  tick += 1;
  const at = uploadedAt || new Date(Date.now() + tick * 1000).toISOString();
  const r = await db
    .prepare(
      `INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, uploaded_by, uploaded_at,
                                   verified_at, rejection_reason)
       VALUES (?, 'prescription', ?, ?, ?, 'image/jpeg', ?, ?, ?, ?)`
    )
    .run(orderId, status, `orders/${orderId}/prescription/${name}`, name, medrepId, at, verifiedAt, reason);
  return r.lastInsertRowid;
}

const queue = async (state = 'pending', token = dispatchToken) =>
  (await request(app).get(`/api/dispatch/pharmacy/queue?state=${state}`).set(auth(token))).body.data;
const idsOf = (data) => data.orders.map((o) => o.id);
const recent = async () => (await request(app).get('/api/dispatch/recent').set(auth(dispatchToken))).body.data;
const verify = (id, token = dispatchToken, body = {}) => request(app).post(`/api/dispatch/pharmacy/orders/${id}/verify`).set(auth(token)).send(body);
const reject = (id, body, token = dispatchToken) => request(app).post(`/api/dispatch/pharmacy/orders/${id}/reject`).set(auth(token)).send(body);
const confirm = (id) => request(app).post(`/api/dispatch/orders/${id}/confirm-delivery`).set(auth(dispatchToken)).send({});

describe('summarize — the state of an order\'s prescription', () => {
  const row = (o) => ({ id: 1, status: 'pending', uploaded_at: '2026-09-25T01:00:00.000Z', verified_at: null, ...o });

  test('none, pending, verified', () => {
    expect(summarize([]).state).toBe('none');
    expect(summarize([row({})]).state).toBe('pending');
    expect(summarize([row({ status: 'verified' })]).state).toBe('verified');
  });

  test('every file has to be verified', () => {
    expect(summarize([row({ id: 1, status: 'verified' }), row({ id: 2, status: 'pending' })]).state).toBe('pending');
  });

  test('a rejection stands until the MedRep uploads something after it', () => {
    const rejected = row({ id: 1, status: 'rejected', verified_at: '2026-09-25T02:00:00.000Z' });
    expect(summarize([rejected]).state).toBe('rejected');

    const replaced = row({ id: 2, status: 'pending', uploaded_at: '2026-09-25T03:00:00.000Z' });
    const s = summarize([rejected, replaced]);
    expect(s.state).toBe('pending');
    expect(s.prescriptions.find((p) => p.id === 1).superseded).toBe(true);

    // ...and once the replacement is verified the order is clear.
    expect(summarize([rejected, { ...replaced, status: 'verified' }]).state).toBe('verified');
  });

  test('a page uploaded BEFORE another was rejected does not clear it', () => {
    const pageA = row({ id: 1, status: 'rejected', uploaded_at: '2026-09-25T01:00:00.000Z', verified_at: '2026-09-25T05:00:00.000Z' });
    const pageB = row({ id: 2, status: 'verified', uploaded_at: '2026-09-25T02:00:00.000Z' });
    expect(summarize([pageA, pageB]).state).toBe('rejected');
  });
});

describe('rxBadge — what the Dispatch board says', () => {
  test('the wording the business asked for', () => {
    expect(rxBadge('verified', false).label).toBe('Rx Verified — Awaiting Finance');
    expect(rxBadge('pending', true).label).toBe('Finance Confirmed — Awaiting Rx Verification');
    expect(rxBadge('pending', false).label).toMatch(/Awaiting Rx Verification and Finance/);
    expect(rxBadge('verified', true).tone).toBe('ok');
    expect(rxBadge('rejected', true).tone).toBe('block');
    expect(rxBadge('none', true)).toBeNull();
  });
});

describe('Pharmacy queue, verification and the gate', () => {
  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    managementToken = await loginAs('manager@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    adminToken = await loginAs('admin@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    dispatchId = (await db.prepare("SELECT id FROM users WHERE email = 'dispatch@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('early visibility: an order with a prescription is in the queue before Finance confirms it', async () => {
    const preFinance = await orderAt('ready_for_finance_verified');
    const atFinance = await orderAt('ready_for_draft_invoice');
    await addRx(preFinance.id);
    await addRx(atFinance.id);
    const data = await queue('pending');
    expect(idsOf(data)).toEqual(expect.arrayContaining([preFinance.id, atFinance.id]));

    const byId = Object.fromEntries(data.orders.map((o) => [o.id, o]));
    expect(byId[preFinance.id].finance_cleared).toBe(false);
    expect(byId[atFinance.id].finance_cleared).toBe(true);
  });

  test('not listed: no prescription, awaiting Management, imported, already shipped', async () => {
    const noRx = await orderAt('ready_for_finance_verified');
    const awaitingMgmt = await orderAt('pending_management_approval');
    const imported = await orderAt('ready_for_dispatch', { prefix: 'ZOHO-SO-RX' });
    const shipped = await orderAt('tracking_shared');
    await addRx(awaitingMgmt.id);
    await addRx(imported.id);
    await addRx(shipped.id);
    const ids = idsOf(await queue('all'));
    for (const o of [noRx, awaitingMgmt, imported, shipped]) expect(ids).not.toContain(o.id);
  });

  test('a deleted prescription no longer counts', async () => {
    const o = await orderAt('ready_for_finance_verified');
    const rx = await addRx(o.id);
    await db.prepare('UPDATE payment_proofs SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), rx);
    expect(idsOf(await queue('all'))).not.toContain(o.id);
  });

  test('verify clears the prescription, records who, and changes no order status', async () => {
    const o = await orderAt('ready_for_finance_verified');
    await addRx(o.id, { name: 'page1.jpg' });
    await addRx(o.id, { name: 'page2.jpg' });

    const res = await verify(o.id);
    expect(res.status).toBe(200);
    expect(res.body.data.rx_state).toBe('verified');
    expect(res.body.data.prescriptions.every((p) => p.status === 'verified' && p.verified_by_name)).toBe(true);

    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id)).status).toBe('ready_for_finance_verified');
    const ev = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'RX_VERIFIED'").get(o.id);
    expect(ev).toBeTruthy();
    expect(ev.actor_id).toBe(dispatchId);

    expect(idsOf(await queue('verified'))).toContain(o.id);
    expect(idsOf(await queue('pending'))).not.toContain(o.id);

    // Nothing left to review.
    expect((await verify(o.id)).status).toBe(404);
  });

  test('reject needs a reason, tells the MedRep, and a replacement puts it back in the queue', async () => {
    const o = await orderAt('ready_for_draft_invoice');
    await addRx(o.id);

    expect((await reject(o.id, {})).status).toBe(400);
    expect((await reject(o.id, { reason: '   ' })).status).toBe(400);

    const res = await reject(o.id, { reason: 'Prescription is unsigned' });
    expect(res.status).toBe(200);
    expect(res.body.data.rx_state).toBe('rejected');
    expect(res.body.data.prescriptions[0].rejection_reason).toBe('Prescription is unsigned');
    expect(idsOf(await queue('rejected'))).toContain(o.id);

    const note = await db
      .prepare('SELECT * FROM notifications WHERE order_id = ? AND recipient_id = ? ORDER BY id DESC LIMIT 1')
      .get(o.id, medrepId);
    expect(note.message).toMatch(/unsigned/);

    // The MedRep uploads a replacement: a new pending prescription.
    await new Promise((r) => setTimeout(r, 5));
    await addRx(o.id, { name: 'replacement.jpg', uploadedAt: new Date(Date.now() + 60_000).toISOString() });
    const pendingIds = idsOf(await queue('pending'));
    expect(pendingIds).toContain(o.id);
    expect(idsOf(await queue('rejected'))).not.toContain(o.id);

    // Verify targets only the pending one; the old rejection stays as history.
    expect((await verify(o.id)).status).toBe(200);
    expect(idsOf(await queue('verified'))).toContain(o.id);
  });

  test('a single file can be decided on its own', async () => {
    const o = await orderAt('ready_for_finance_verified');
    const a = await addRx(o.id, { name: 'a.jpg' });
    await addRx(o.id, { name: 'b.jpg' });

    const res = await verify(o.id, dispatchToken, { attachment_id: a });
    expect(res.status).toBe(200);
    // One page is still waiting, so the order as a whole is still pending.
    expect(res.body.data.rx_state).toBe('pending');
  });

  test('who may decide: Dispatch and Admin; Management can look; a MedRep is out', async () => {
    const o = await orderAt('ready_for_finance_verified');
    await addRx(o.id);

    expect((await verify(o.id, managementToken)).status).toBe(403);
    expect((await reject(o.id, { reason: 'x' }, managementToken)).status).toBe(403);
    expect((await verify(o.id, medrepToken)).status).toBe(403);

    const asManagement = await queue('pending', managementToken);
    expect(idsOf(asManagement)).toContain(o.id);
    expect(asManagement.can_decide).toBe(false);

    expect((await verify(o.id, adminToken)).status).toBe(200);
  });

  test('verify is refused for an order that is not at the pharmacy stage', async () => {
    const shipped = await orderAt('tracking_shared');
    await addRx(shipped.id);
    const res = await verify(shipped.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_IN_QUEUE');
  });

  describe('the gate', () => {
    test('confirming for delivery is refused while the prescription is pending, and allowed once verified', async () => {
      const o = await orderAt('ready_for_draft_invoice');
      await addRx(o.id);

      const blocked = await confirm(o.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('RX_NOT_VERIFIED');
      expect(blocked.body.error.message).toMatch(/pharmacist/i);
      expect(await db.prepare("SELECT 1 AS x FROM order_events WHERE order_id = ? AND event_type = 'DELIVERY_CONFIRMED'").get(o.id)).toBeUndefined();

      await verify(o.id);
      expect((await confirm(o.id)).status).toBe(200);
    });

    test('a rejected prescription blocks too, with its own message', async () => {
      const o = await orderAt('ready_for_dispatch');
      await addRx(o.id);
      await reject(o.id, { reason: 'Illegible' });
      const res = await confirm(o.id);
      expect(res.status).toBe(409);
      expect(res.body.error.rx_state).toBe('rejected');
    });

    test('adding tracking is gated the same way', async () => {
      const o = await orderAt('ready_for_dispatch');
      await addRx(o.id);
      const blocked = await request(app)
        .post(`/api/dispatch/orders/${o.id}/tracking`)
        .set(auth(dispatchToken))
        .send({ courier: 'Lalamove', tracking_number: 'https://share.lalamove.com/x' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('RX_NOT_VERIFIED');

      await verify(o.id);
      const ok = await request(app)
        .post(`/api/dispatch/orders/${o.id}/tracking`)
        .set(auth(dispatchToken))
        .send({ courier: 'Lalamove', tracking_number: 'https://share.lalamove.com/x' });
      expect(ok.status).toBe(200);
    });

    test('an order with no prescription is untouched by the gate', async () => {
      const o = await orderAt('ready_for_draft_invoice');
      expect((await confirm(o.id)).status).toBe(200);
    });

    test('a parcel that has already shipped is not blocked by an old, never-reviewed prescription', async () => {
      const o = await orderAt('tracking_shared');
      await addRx(o.id); // pending, as every pre-existing hospital order's is
      expect((await confirm(o.id)).status).toBe(200);
    });
  });

  describe('badges on the Dispatch board', () => {
    test('waiting on Finance: Rx Verified — Awaiting Finance', async () => {
      const o = await orderAt('ready_for_finance_verified');
      await addRx(o.id);
      await verify(o.id);
      const row = (await recent()).new_draft_sos.find((x) => x.id === o.id);
      expect(row.rx_state).toBe('verified');
      expect(row.rx_badge.label).toBe('Rx Verified — Awaiting Finance');
      expect(row.rx_blocking).toBe(false);
    });

    test('Finance confirmed, prescription not: Finance Confirmed — Awaiting Rx Verification', async () => {
      const o = await orderAt('ready_for_draft_invoice');
      await addRx(o.id);
      const row = (await recent()).finance_confirmed.find((x) => x.id === o.id);
      expect(row.rx_badge.label).toBe('Finance Confirmed — Awaiting Rx Verification');
      expect(row.rx_badge.tone).toBe('block');
      expect(row.rx_blocking).toBe(true);
    });

    test('both cleared: clear to dispatch; no prescription: no badge', async () => {
      const cleared = await orderAt('ready_for_dispatch');
      await addRx(cleared.id);
      await verify(cleared.id);
      const plain = await orderAt('ready_for_dispatch');

      const rows = (await recent()).finance_confirmed;
      expect(rows.find((x) => x.id === cleared.id).rx_badge.tone).toBe('ok');
      const p = rows.find((x) => x.id === plain.id);
      expect(p.rx_badge).toBeNull();
      expect(p.rx_state).toBe('none');
      expect(p.rx_blocking).toBe(false);
    });
  });
});
