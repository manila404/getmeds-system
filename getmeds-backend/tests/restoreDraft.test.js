/**
 * Oct 12, 2026 — Management brings a cancelled draft back, straight to Management approval.
 * The case: a paid draft cancelled "out of stock" with a refund pending; the stock came back.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const created = [];
let mgr, rep, fin, medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function draft(extra = {}) {
  const ref = `GM-RST-${stamp}-${created.length}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
       VALUES (?, ?, ?, 'draft', 'direct', 5000, '1 Restore St')`
    )
    .run(ref, customerId, medrepId);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  created.push(id);
  return id;
}
const cancel = (id, kind = 'keep_record') =>
  request(app).post(`/api/orders/${id}/cancel-draft`).set(auth(mgr)).send({ reason: 'HYDROXYGET OUT OF STOCK', kind });
const restore = (id, body = { reason: 'Stock is available again' }, token = mgr) =>
  request(app).post(`/api/orders/${id}/restore-draft`).set(auth(token)).send(body);
const row = (id) => db.prepare('SELECT status, draft_cancelled_at, draft_cancel_kind, refund_status FROM orders WHERE id = ?').get(id);

beforeAll(async () => {
  mgr = await loginAs('manager@getmeds.ph');
  rep = await loginAs('medrep@getmeds.ph');
  fin = await loginAs('finance@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
});

afterAll(async () => {
  for (const id of created) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
});

describe('restoring a cancelled draft', () => {
  test('a cancelled draft with a pending refund goes back to approval and the refund is closed', async () => {
    const id = await draft();
    expect((await cancel(id)).status).toBe(200);
    expect((await row(id)).refund_status).toBe('pending');

    const res = await restore(id);
    expect(res.status).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('pending_management_approval');
    expect(after.draft_cancelled_at).toBeNull();
    expect(after.draft_cancel_kind).toBeNull();
    expect(after.refund_status).toBeNull();

    const ev = await db.prepare("SELECT event_type FROM order_events WHERE order_id = ? ORDER BY id DESC LIMIT 1").get(id);
    expect(ev.event_type).toBe('DRAFT_RESTORED');
  });

  test('a reason is required, and only Management / Admin can restore', async () => {
    const id = await draft();
    await cancel(id);
    expect((await restore(id, {})).status).toBe(400);
    expect((await restore(id, { reason: 'x' }, rep)).status).toBe(403);
    expect((await restore(id, { reason: 'x' }, fin)).status).toBe(403);
    expect((await row(id)).status).toBe('cancelled');
  });

  test('a refund that was already paid blocks the restore', async () => {
    const id = await draft();
    await cancel(id);
    await db.prepare("UPDATE orders SET refund_status = 'done', refund_amount = 5000, refund_reference = 'REF-1' WHERE id = ?").run(id);
    const res = await restore(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFUND_ALREADY_PAID');
    expect((await row(id)).status).toBe('cancelled');
  });

  test('an order that is not a cancelled draft, or is already in Zoho, is refused', async () => {
    const live = await draft();
    expect((await restore(live)).status).toBe(409); // still a draft, not cancelled

    const inZoho = await draft();
    await cancel(inZoho, 'discard');
    await db.prepare("UPDATE orders SET zoho_so_id = 'ZOHO-X' WHERE id = ?").run(inZoho);
    const res = await restore(inZoho);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_ZOHO');
  });

  test('restoring twice only works once', async () => {
    const id = await draft();
    await cancel(id);
    expect((await restore(id)).status).toBe(200);
    expect((await restore(id)).status).toBe(409);
  });
});
