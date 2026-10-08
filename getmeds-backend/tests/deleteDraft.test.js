/**
 * "Delete permanently" for a draft. Oct 8, 2026.
 *
 * An unpaid draft that never reached Zoho can be deleted by Management/Admin, after
 * typing the order id. A paid draft, or one already in Zoho, is never deleted.
 * The MedRep keeps it in their list, marked Deleted, until they read the notice or
 * one day passes; then it is erased for good.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const deletedDraftPurge = require('../src/services/deletedDraftPurge');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const orderIds = [];
let managerToken, medrepToken, medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function draft({ advance = false, proof = false, zohoSoId = null } = {}) {
  const ref = `GM-DD-${stamp}-${orderIds.length}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                         delivery_address, submitted_at, intake_payment_terms, zoho_so_id)
     VALUES (?, ?, ?, 'draft', 'credit', 1000, '1 Test St', ?, ?, ?)`
  ).run(ref, customerId, medrepId, new Date().toISOString(), advance ? 'Advanced Payment' : 'COD', zohoSoId);
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
const del = (id, body, token = managerToken) => request(app).post(`/api/orders/${id}/delete-draft`).set(auth(token)).send(body);
const cancel = (id, body) => request(app).post(`/api/orders/${id}/cancel-draft`).set(auth(managerToken)).send(body);
const exists = async (id) => !!(await db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(id));
const statusOf = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id))?.status;
const myList = async () => (await request(app).get('/api/orders?limit=100').set(auth(medrepToken))).body.data.orders.map((o) => o.id);
const managerList = async () => (await request(app).get('/api/orders?limit=100').set(auth(managerToken))).body.data.orders.map((o) => o.id);
const deletionNote = (ref) => db.prepare('SELECT id, order_id, is_read FROM notifications WHERE recipient_id = ? AND message LIKE ?').get(medrepId, `%${ref}%deleted%`);

beforeAll(async () => {
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Delete Customer ${stamp}`, `DD-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Delete Customer ${stamp}`)).id;
});

afterAll(async () => {
  for (const id of orderIds) {
    for (const t of ['notifications', 'order_events', 'payment_proofs']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare("DELETE FROM notifications WHERE order_id IS NULL AND message LIKE ?").run(`%GM-DD-${stamp}%`);
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

describe('delete a draft permanently', () => {
  test('deleting hides the draft from the back office, keeps it in the MedRep list, and tells them', async () => {
    const d = await draft();
    const res = await del(d.id, { reason: 'Duplicate', confirm: d.ref });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(d.ref);
    expect(await statusOf(d.id)).toBe('deleted');
    expect(await managerList()).not.toContain(d.id);
    expect(await myList()).toContain(d.id);
    const note = await deletionNote(d.ref);
    expect(note).toBeTruthy();
    expect(note.order_id).toBeNull();
  });

  test('the MedRep reading the notice erases the draft and its items; the notice stays', async () => {
    const d = await draft();
    const product = await db.prepare('SELECT id FROM products LIMIT 1').get();
    await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 1, 1000, 1000, 1000)').run(d.id, product.id);
    expect((await del(d.id, { reason: 'Duplicate', confirm: d.ref })).status).toBe(200);
    const note = await deletionNote(d.ref);
    expect((await request(app).patch(`/api/notifications/${note.id}/read`).set(auth(medrepToken))).status).toBe(200);
    expect(await exists(d.id)).toBe(false);
    expect(await db.prepare('SELECT 1 AS x FROM order_items WHERE order_id = ?').get(d.id)).toBeFalsy();
    expect((await deletionNote(d.ref)).is_read).toBe(1);
  });

  test('"mark all read" erases it too', async () => {
    const d = await draft();
    expect((await del(d.id, { reason: 'Duplicate', confirm: d.ref })).status).toBe(200);
    expect((await request(app).patch('/api/notifications/mark-all-read').set(auth(medrepToken))).status).toBe(200);
    expect(await exists(d.id)).toBe(false);
  });

  test('after one day it leaves the MedRep list, and the daily purge erases it', async () => {
    const d = await draft();
    expect((await del(d.id, { reason: 'Duplicate', confirm: d.ref })).status).toBe(200);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await db.prepare('UPDATE orders SET draft_cancelled_at = ? WHERE id = ?').run(twoDaysAgo, d.id);
    expect(await myList()).not.toContain(d.id);
    await deletedDraftPurge.purgeExpired();
    expect(await exists(d.id)).toBe(false);
  });

  test('the purge never touches a fresh deletion, or an order Zoho reported deleted', async () => {
    const fresh = await draft();
    expect((await del(fresh.id, { reason: 'Duplicate', confirm: fresh.ref })).status).toBe(200);
    const zohoDeleted = await draft();
    await db.prepare("UPDATE orders SET status = 'deleted' WHERE id = ?").run(zohoDeleted.id);
    await db.prepare("UPDATE orders SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(zohoDeleted.id);
    await deletedDraftPurge.purgeExpired();
    expect(await exists(fresh.id)).toBe(true);
    expect(await exists(zohoDeleted.id)).toBe(true);
  });

  test('the order id must be typed exactly', async () => {
    const d = await draft();
    const res = await del(d.id, { reason: 'Duplicate', confirm: 'GM-WRONG' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRM_MISMATCH');
    expect(await exists(d.id)).toBe(true);
  });

  test('a reason is required', async () => {
    const d = await draft();
    const res = await del(d.id, { confirm: d.ref });
    expect(res.status).toBe(400);
    expect(await exists(d.id)).toBe(true);
  });

  test('a draft with a payment on record is refused', async () => {
    const d = await draft({ advance: true, proof: true });
    const res = await del(d.id, { reason: 'x', confirm: d.ref });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_ON_RECORD');
    expect(await exists(d.id)).toBe(true);
  });

  test('a draft already in Zoho is refused', async () => {
    const d = await draft({ zohoSoId: `SO-${stamp}` });
    const res = await del(d.id, { reason: 'x', confirm: d.ref });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_ZOHO');
    expect(await exists(d.id)).toBe(true);
  });

  test('a MedRep cannot delete', async () => {
    const d = await draft();
    const res = await del(d.id, { reason: 'x', confirm: d.ref }, medrepToken);
    expect(res.status).toBe(403);
    expect(await exists(d.id)).toBe(true);
  });

  test('a draft cancelled as discard can be deleted; one kept on record cannot', async () => {
    const a = await draft();
    expect((await cancel(a.id, { reason: 'Mistake', kind: 'discard' })).status).toBe(200);
    expect((await del(a.id, { reason: 'Mistake', confirm: a.ref })).status).toBe(200);
    expect(await statusOf(a.id)).toBe('deleted');

    const b = await draft();
    expect((await cancel(b.id, { reason: 'Paid', kind: 'keep_record' })).status).toBe(200);
    const res = await del(b.id, { reason: 'x', confirm: b.ref });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_DELETABLE');
    expect(await exists(b.id)).toBe(true);
  });
});
