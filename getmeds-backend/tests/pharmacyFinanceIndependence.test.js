/**
 * Sep 26, 2026 — Pharmacy and Finance are two independent tracks.
 *
 * GM-20260925-0012: Pharmacy rejected the prescription; the MedRep pressed "Re-submit"
 * and the order went to FINANCE, while Pharmacy's Rejected tab kept it. There was no
 * way to answer Pharmacy at all, and answering one department could disturb the other.
 *
 * Pinned here:
 *   - re-submitting a rejected prescription puts it back in Pharmacy's Awaiting review,
 *     with the MedRep's note, and changes NOTHING on Finance's side: the order's
 *     status, and who is notified
 *   - a Finance hold does not take an order out of Pharmacy's queue
 *   - answering Finance's hold does not touch the prescription
 *   - uploading a prescription does not send a Finance hold back to Finance
 *   - who may, and when there is nothing to re-submit
 */
jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return { ...actual, downloadFile: jest.fn(async () => Buffer.from('x')) };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { logEvent } = require('../src/services/auditService');

const created = [];
let dispatchToken, medrepToken, otherMedrepToken, medrepId, customerId;
const stamp = Date.now();
let seq = 0;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function order(status, { heldFrom = null } = {}) {
  seq += 1;
  const ref = `GM-INDEP-${stamp}-${seq}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address,
                           division, zoho_so_id, zoho_so_number)
       VALUES (?, ?, ?, ?, 'credit', 500, '1 Ind St', 'HOS', ?, 'SO-IND')`
    )
    .run(ref, customerId, medrepId, status, `ZSO-INDEP-${stamp}-${seq}`);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  if (heldFrom) {
    await logEvent({ orderId: row.id, eventType: 'ORDER_HELD', oldStatus: heldFrom, newStatus: 'on_hold', actorName: 'Finance', notes: 'Finance hold' });
  }
  return row;
}

async function rx(orderId, status = 'rejected', reason = 'reject test') {
  const at = new Date(Date.now() - 60000).toISOString();
  const r = await db
    .prepare(
      `INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, uploaded_by, uploaded_at,
                                   verified_at, rejection_reason)
       VALUES (?, 'prescription', ?, ?, 'rx.jpg', 'image/jpeg', ?, ?, ?, ?)`
    )
    .run(orderId, status, `orders/${orderId}/prescription/rx.jpg`, medrepId, at, status === 'rejected' ? new Date(Date.now() - 30000).toISOString() : null, status === 'rejected' ? reason : null);
  return r.lastInsertRowid;
}

const resubmitRx = (id, body, token = medrepToken) => request(app).post(`/api/orders/${id}/resubmit-prescription`).set(auth(token)).send(body);
const queue = async (state) => (await request(app).get(`/api/dispatch/pharmacy/queue?state=${state}`).set(auth(dispatchToken))).body.data;
const rowStatus = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;
// Who was told, by role, for in-app messages about this order containing the text.
const notifiedRoles = async (orderId, text) =>
  (await db.prepare("SELECT DISTINCT u.role FROM notifications n JOIN users u ON u.id = n.recipient_id WHERE n.order_id = ? AND n.channel = 'in_app' AND n.message LIKE ?").all(orderId, '%' + text + '%')).map((r) => r.role);

describe('Pharmacy and Finance: independent tracks', () => {
  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const other = await db.prepare("SELECT email FROM users WHERE role = 'medrep' AND email <> 'medrep@getmeds.ph' AND is_active = 1 LIMIT 1").get();
    otherMedrepToken = other ? await loginAs(other.email) : null;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('Scenario A: re-submitting goes back to Pharmacy Awaiting review, and Finance is untouched', async () => {
    const o = await order('ready_for_dispatch'); // Finance already confirmed
    await rx(o.id);
    expect((await queue('rejected')).orders.map((x) => x.id)).toContain(o.id);

    const res = await resubmitRx(o.id, { note: 'Quantity is on page 2' });
    expect(res.status).toBe(200);
    expect(res.body.data.rx_state).toBe('pending');

    const pending = (await queue('pending')).orders.find((x) => x.id === o.id);
    expect(pending).toBeTruthy();
    expect(pending.resubmitted.note).toBe('Quantity is on page 2');
    expect((await queue('rejected')).orders.map((x) => x.id)).not.toContain(o.id);

    // Finance: same stage, nobody in Finance told.
    expect(await rowStatus(o.id)).toBe('ready_for_dispatch');
    expect(await notifiedRoles(o.id, 're-submitted by')).toEqual(['dispatch']);
    const event = await db.prepare("SELECT event_type, old_status, new_status FROM order_events WHERE order_id = ? AND event_type = 'RX_RESUBMITTED'").get(o.id);
    expect(event.old_status).toBe(event.new_status);
  });

  test('a note is required, only the order\'s own MedRep may, and there must be a rejection to answer', async () => {
    const o = await order('ready_for_finance_verified');
    await rx(o.id);
    expect((await resubmitRx(o.id, { note: '  ' })).status).toBe(400);
    if (otherMedrepToken) expect((await resubmitRx(o.id, { note: 'mine now' }, otherMedrepToken)).status).toBe(403);
    expect((await resubmitRx(o.id, { note: 'ok' }, dispatchToken)).status).toBe(403);

    const clean = await order('ready_for_finance_verified');
    await rx(clean.id, 'pending');
    const res = await resubmitRx(clean.id, { note: 'nothing was rejected' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOTHING_TO_RESUBMIT');
  });

  test('Scenario C: a Finance hold does not take the order out of Pharmacy, and the two are answered separately', async () => {
    const o = await order('on_hold', { heldFrom: 'ready_for_finance_verified' });
    await rx(o.id);

    const row = (await queue('rejected')).orders.find((x) => x.id === o.id);
    expect(row).toBeTruthy();
    expect(row.reviewable).toBe(true);

    // Answering Pharmacy: the order stays on hold, waiting on Finance's own answer.
    const res = await resubmitRx(o.id, { note: 'Replacement attached' });
    expect(res.status).toBe(200);
    expect(await rowStatus(o.id)).toBe('on_hold');
    expect((await queue('pending')).orders.map((x) => x.id)).toContain(o.id);
    expect(await notifiedRoles(o.id, 'ready for your re-check')).toEqual([]);

    // Answering Finance: goes back to Finance and leaves the prescription pending.
    const fin = await request(app).post(`/api/orders/${o.id}/resubmit`).set(auth(medrepToken)).send({ reason: 'Proof of payment uploaded' });
    expect(fin.status).toBe(200);
    expect(await rowStatus(o.id)).toBe('ready_for_finance_verified');
    const p = await db.prepare("SELECT status FROM payment_proofs WHERE order_id = ? AND file_type = 'prescription'").get(o.id);
    expect(p.status).toBe('pending');
  });

  test('Scenario B: answering Finance leaves a rejected prescription rejected', async () => {
    const o = await order('on_hold', { heldFrom: 'ready_for_finance_verified' });
    await rx(o.id);
    const fin = await request(app).post(`/api/orders/${o.id}/resubmit`).set(auth(medrepToken)).send({ reason: 'Proof of payment uploaded' });
    expect(fin.status).toBe(200);
    const p = await db.prepare("SELECT status, rejection_reason FROM payment_proofs WHERE order_id = ? AND file_type = 'prescription'").get(o.id);
    expect(p.status).toBe('rejected');
    expect(p.rejection_reason).toBe('reject test');
    expect((await queue('rejected')).orders.map((x) => x.id)).toContain(o.id);
  });

  test('uploading a prescription does not send a Finance hold back to Finance', async () => {
    jest.spyOn(zoho, 'addSalesOrderAttachment').mockResolvedValue({ document: { document_id: 'D1' } });
    const o = await order('on_hold', { heldFrom: 'ready_for_finance_verified' });
    await rx(o.id);
    const res = await request(app)
      .post(`/api/orders/${o.id}/attachments`)
      .set(auth(medrepToken))
      .send({ storagePath: `orders/${o.id}/payment_proof/new-rx.jpg`, fileName: 'new-rx.jpg', contentType: 'image/jpeg', fileSize: 1000, file_type: 'prescription' });
    expect(res.status).toBe(200);
    expect(await rowStatus(o.id)).toBe('on_hold');
    // The new file answers the rejection on Pharmacy's side.
    expect((await queue('pending')).orders.map((x) => x.id)).toContain(o.id);
    jest.restoreAllMocks();
  });
});
