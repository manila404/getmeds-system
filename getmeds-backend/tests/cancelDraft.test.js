/**
 * Management/Admin cancel a DRAFT. Oct 3, 2026.
 *
 * The cancelled draft must (1) need a reason, (2) work only on a draft with no
 * Zoho Sales Order, (3) vanish from every Finance and Management list and count,
 * and (4) stay visible to the MedRep who owns it, as Cancelled with the reason.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const orderIds = [];
let managerToken, medrepToken, financeToken, medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function order({ status = 'draft', soId = null } = {}) {
  const ref = `GM-CD-${stamp}-${orderIds.length}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                         delivery_address, submitted_at, zoho_so_id)
     VALUES (?, ?, ?, ?, 'credit', 700, '1 Test St', ?, ?)`
  ).run(ref, customerId, medrepId, status, new Date().toISOString(), soId);
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  orderIds.push(row.id);
  return { id: row.id, ref };
}
const cancel = (id, body, token = managerToken) =>
  request(app).post(`/api/orders/${id}/cancel-draft`).set(auth(token)).send(body);
const row = (id) => db.prepare('SELECT status, draft_cancelled_at, draft_cancel_reason FROM orders WHERE id = ?').get(id);

beforeAll(async () => {
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  financeToken = await loginAs('finance@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)")
    .run(`Cancel Draft Customer ${stamp}`, `CD-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Cancel Draft Customer ${stamp}`)).id;
});

afterAll(async () => {
  for (const id of orderIds) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

describe('POST /api/orders/:id/cancel-draft', () => {
  test('cancels a draft, records who and why, and tells the MedRep', async () => {
    const o = await order();
    const res = await cancel(o.id, { reason: 'Duplicate of GM-0001' });
    expect(res.status).toBe(200);
    const r = await row(o.id);
    expect(r.status).toBe('cancelled');
    expect(r.draft_cancelled_at).toBeTruthy();
    expect(r.draft_cancel_reason).toBe('Duplicate of GM-0001');
    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'DRAFT_CANCELLED'").get(o.id);
    expect(ev.notes).toMatch(/Duplicate of GM-0001/);
    const n = await db.prepare("SELECT 1 AS x FROM notifications WHERE order_id = ? AND recipient_id = ?").get(o.id, medrepId);
    expect(n).toBeTruthy();
  });

  test('a reason is required, and nothing changes without one', async () => {
    const o = await order();
    const res = await cancel(o.id, { reason: '   ' });
    expect(res.status).toBe(400);
    expect((await row(o.id)).status).toBe('draft');
  });

  test('only a draft can be cancelled this way', async () => {
    const o = await order({ status: 'pending_management_approval' });
    const res = await cancel(o.id, { reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_A_DRAFT');
  });

  test('a draft that already has a Zoho Sales Order is refused', async () => {
    const o = await order({ soId: `ZSO-${stamp}` });
    const res = await cancel(o.id, { reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_ZOHO');
    expect((await row(o.id)).status).toBe('draft');
  });

  test('a MedRep cannot cancel', async () => {
    const o = await order();
    const res = await cancel(o.id, { reason: 'x' }, medrepToken);
    expect(res.status).toBe(403);
    expect((await row(o.id)).status).toBe('draft');
  });
});

describe('a cancelled draft is hidden from the back office but not from its MedRep', () => {
  let cancelled, plain;
  beforeAll(async () => {
    cancelled = await order();
    plain = await order();
    await cancel(cancelled.id, { reason: 'Mistake' });
  });

  test('Management\'s orders list leaves it out (and keeps the other draft)', async () => {
    const res = await request(app).get('/api/management/orders').query({ limit: 5000 }).set(auth(managerToken));
    const refs = (res.body.data.orders || []).map((o) => o.getmeds_order_id);
    expect(refs).not.toContain(cancelled.ref);
    expect(refs).toContain(plain.ref);
  });

  test('Finance\'s queue leaves it out of the list and the counts', async () => {
    const res = await request(app).get('/api/finance/queue').query({ origin: 'all', limit: 5000 }).set(auth(financeToken));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(cancelled.ref);
  });

  test('the Management summary does not count it as an exception', async () => {
    const before = (await request(app).get('/api/management/summary').set(auth(managerToken))).body.data.exception_count;
    const another = await order();
    await cancel(another.id, { reason: 'Test' });
    const after = (await request(app).get('/api/management/summary').set(auth(managerToken))).body.data.exception_count;
    expect(after).toBe(before);
  });

  test('the owning MedRep still sees it, as cancelled, with the reason', async () => {
    const res = await request(app).get('/api/orders').query({ limit: 200 }).set(auth(medrepToken));
    const mine = (res.body.data.orders || []).find((o) => o.getmeds_order_id === cancelled.ref);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('cancelled');
    expect(mine.draft_cancel_reason).toBe('Mistake');
  });
});
