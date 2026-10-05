/**
 * Paid drafts: "cancel and keep record" with refund tracking. Oct 5, 2026.
 *
 * A draft paid in advance and then cancelled must leave a record, never be
 * discardable, and give Finance a refund to follow up. Management can see it;
 * only Finance/Admin can record the refund; the MedRep sees the status.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const orderIds = [];
let managerToken, medrepToken, financeToken, adminToken, medrepId, financeId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function draft({ advance = false, proof = false, total = 1000 } = {}) {
  const ref = `GM-RF-${stamp}-${orderIds.length}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                         delivery_address, submitted_at, intake_payment_terms)
     VALUES (?, ?, ?, 'draft', 'credit', ?, '1 Test St', ?, ?)`
  ).run(ref, customerId, medrepId, total, new Date().toISOString(), advance ? 'Advanced Payment' : 'COD');
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  orderIds.push(id);
  if (proof) {
    await db.prepare(
      `INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, file_size, uploaded_by, uploaded_at)
       VALUES (?, 'payment_proof', 'pending', ?, 'slip.png', 'image/png', 100, ?, ?)`
    ).run(id, `orders/${id}/payment_proof/${ref}.png`, medrepId, new Date().toISOString());
  }
  return { id, ref };
}
const cancel = (id, body, token = managerToken) => request(app).post(`/api/orders/${id}/cancel-draft`).set(auth(token)).send(body);
const refund = (id, body, token = financeToken) => request(app).post(`/api/orders/${id}/refund`).set(auth(token)).send(body);
const row = (id) => db.prepare('SELECT status, draft_cancel_kind, refund_status, refund_received_amount, refund_amount, refund_reference FROM orders WHERE id = ?').get(id);

beforeAll(async () => {
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  financeToken = await loginAs('finance@getmeds.ph');
  adminToken = await loginAs('admin@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  financeId = (await db.prepare("SELECT id FROM users WHERE email = 'finance@getmeds.ph'").get()).id;
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Refund Customer ${stamp}`, `RF-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Refund Customer ${stamp}`)).id;
});

afterAll(async () => {
  for (const id of orderIds) {
    for (const t of ['notifications', 'order_events', 'payment_proofs']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

describe('the two kinds of cancel', () => {
  test('a paid draft defaults to keep-record, becomes Refund pending, and Finance and the MedRep are told', async () => {
    const d = await draft({ advance: true, proof: true, total: 1500 });
    const res = await cancel(d.id, { reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    const r = await row(d.id);
    expect(r.status).toBe('cancelled');
    expect(r.draft_cancel_kind).toBe('keep_record');
    expect(r.refund_status).toBe('pending');
    expect(await db.prepare('SELECT 1 AS x FROM notifications WHERE order_id = ? AND recipient_id = ?').get(d.id, financeId)).toBeTruthy();
    expect(await db.prepare('SELECT 1 AS x FROM notifications WHERE order_id = ? AND recipient_id = ?').get(d.id, medrepId)).toBeTruthy();
  });

  test('"discard" is REFUSED for a draft with a payment on record, and nothing changes', async () => {
    const d = await draft({ advance: true, proof: true });
    const res = await cancel(d.id, { reason: 'x', kind: 'discard' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_ON_RECORD');
    expect((await row(d.id)).status).toBe('draft');
  });

  test('advance-payment terms alone, or a proof alone, are enough to protect it', async () => {
    const a = await draft({ advance: true });
    const b = await draft({ proof: true });
    expect((await cancel(a.id, { reason: 'x', kind: 'discard' })).status).toBe(409);
    expect((await cancel(b.id, { reason: 'x', kind: 'discard' })).status).toBe(409);
  });

  test('a draft with no money defaults to discard, but can still be kept on record by choice', async () => {
    const a = await draft();
    const b = await draft();
    expect((await cancel(a.id, { reason: 'dup' })).status).toBe(200);
    expect((await row(a.id)).draft_cancel_kind).toBe('discard');
    expect((await row(a.id)).refund_status).toBeNull();
    expect((await cancel(b.id, { reason: 'keep it', kind: 'keep_record' })).status).toBe(200);
    expect((await row(b.id)).refund_status).toBe('pending');
  });

  test('an unknown kind is refused', async () => {
    const d = await draft();
    expect((await cancel(d.id, { reason: 'x', kind: 'delete' })).status).toBe(400);
  });

  test('the Cancel dialog can ask whether a payment is on record', async () => {
    const paid = await draft({ proof: true });
    const plain = await draft();
    const a = await request(app).get(`/api/orders/${paid.id}/payment-on-record`).set(auth(managerToken));
    const b = await request(app).get(`/api/orders/${plain.id}/payment-on-record`).set(auth(managerToken));
    expect(a.body.data.has).toBe(true);
    expect(b.body.data.has).toBe(false);
  });
});

describe('recording the refund', () => {
  let d;
  beforeAll(async () => { d = await draft({ advance: true, proof: true, total: 1000 }); await cancel(d.id, { reason: 'Customer cancelled' }); });

  test('Finance records a PARTIAL refund; the part kept is worked out; the MedRep is told', async () => {
    const res = await refund(d.id, { status: 'done', received_amount: 1000, refund_amount: 800, reference: 'BANK-123', refund_date: '2026-10-06', note: 'less 200 cancellation fee' });
    expect(res.status).toBe(200);
    const r = await row(d.id);
    expect(r.refund_status).toBe('done');
    expect(r.refund_amount).toBe(800);
    expect(r.refund_reference).toBe('BANK-123');
    const list = await request(app).get('/api/finance/refunds?status=done').set(auth(financeToken));
    const mine = list.body.data.refunds.find((x) => x.id === d.id);
    expect(mine.kept_amount).toBe(200);
    const n = await db.prepare("SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ? AND message LIKE 'Refund done%'").get(d.id, medrepId);
    expect(n).toBeTruthy();
  });

  test('a refund can be corrected afterwards, and every change is logged', async () => {
    const res = await refund(d.id, { status: 'done', refund_amount: 850, reference: 'BANK-123', refund_date: '2026-10-06' });
    expect(res.status).toBe(200);
    expect((await row(d.id)).refund_amount).toBe(850);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND event_type = 'REFUND_RECORDED'").get(d.id);
    expect(Number(n.n)).toBe(2);
  });

  test('validation: reference and date are needed for done; refund cannot exceed received; not_due needs a reason', async () => {
    const x = await draft({ advance: true, proof: true, total: 500 });
    await cancel(x.id, { reason: 'x' });
    expect((await refund(x.id, { status: 'done', refund_amount: 100, refund_date: '2026-10-06' })).status).toBe(400);              // no reference
    expect((await refund(x.id, { status: 'done', refund_amount: 100, reference: 'R1' })).status).toBe(400);                         // no date
    expect((await refund(x.id, { status: 'done', received_amount: 100, refund_amount: 200, reference: 'R1', refund_date: '2026-10-06' })).status).toBe(400);
    expect((await refund(x.id, { status: 'not_due' })).status).toBe(400);
    expect((await refund(x.id, { status: 'not_due', note: 'The payment never arrived' })).status).toBe(200);
    expect((await row(x.id)).refund_status).toBe('not_due');
  });

  test('only a cancelled draft kept on record has a refund', async () => {
    const plain = await draft();
    await cancel(plain.id, { reason: 'dup' });
    expect((await refund(plain.id, { status: 'done', refund_amount: 1, reference: 'R', refund_date: '2026-10-06' })).status).toBe(409);
  });
});

describe('who can do what', () => {
  let d;
  beforeAll(async () => { d = await draft({ advance: true, proof: true, total: 700 }); await cancel(d.id, { reason: 'x' }); });

  test('Management can SEE the refund list and totals but cannot record a refund; a MedRep can do neither', async () => {
    const seen = await request(app).get('/api/finance/refunds').set(auth(managerToken));
    expect(seen.status).toBe(200);
    expect(seen.body.data.summary.pending_count).toBeGreaterThanOrEqual(1);
    expect((await refund(d.id, { status: 'not_due', note: 'x' }, managerToken)).status).toBe(403);
    expect((await refund(d.id, { status: 'not_due', note: 'x' }, medrepToken)).status).toBe(403);
    expect((await request(app).get('/api/finance/refunds').set(auth(medrepToken))).status).toBe(403);
  });

  test('Admin can record a refund too, and the badge summary counts what is pending', async () => {
    const before = (await request(app).get('/api/finance/refunds/summary').set(auth(financeToken))).body.data;
    expect((await refund(d.id, { status: 'done', refund_amount: 700, reference: 'ADM-1', refund_date: '2026-10-06' }, adminToken)).status).toBe(200);
    const after = (await request(app).get('/api/finance/refunds/summary').set(auth(financeToken))).body.data;
    expect(after.pending_count).toBe(before.pending_count - 1);
    expect(after.done_count).toBe(before.done_count + 1);
  });

  test('a kept order stays out of every sales count, like any cancelled draft', async () => {
    const res = await request(app).get('/api/management/orders').query({ limit: 5000 }).set(auth(managerToken));
    expect((res.body.data.orders || []).some((o) => o.getmeds_order_id === `GM-RF-${stamp}-0`)).toBe(false);
  });
});
