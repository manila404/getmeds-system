/**
 * Sep 28, 2026 — Pharmacy fixes a miscategorized upload in place, instead of
 * asking for a fresh one: a prescription attached under Proof of Payment or
 * Valid ID (or the reverse) gets its file_type changed, and any decision
 * already on the row (verified/rejected) resets to 'pending' — it has to be
 * looked at again as what it now claims to be.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = [];
let dispatchToken, medrepToken, adminToken;
let medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function orderAt(status = 'ready_for_draft_invoice') {
  const ref = `GM-RETAG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
       VALUES (?, ?, ?, ?, 'credit', 900, '1 Retag St, Cebu')`
    )
    .run(ref, customerId, medrepId, status);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  return row;
}

async function addFile(orderId, { fileType = 'payment_proof', status = 'verified', name = 'slip.jpg' } = {}) {
  await db
    .prepare(
      `INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, uploaded_by, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?)`
    )
    .run(orderId, fileType, status, `orders/${orderId}/${fileType}/${name}`, name, medrepId, status !== 'pending' ? medrepId : null, status !== 'pending' ? new Date().toISOString() : null);
  return (await db.prepare('SELECT id FROM payment_proofs WHERE order_id = ? AND file_name = ?').get(orderId, name)).id;
}

const retag = (orderId, attachmentId, fileType, token = dispatchToken) =>
  request(app)
    .post(`/api/orders/${orderId}/attachments/${attachmentId}/retag`)
    .set(auth(token))
    .send({ file_type: fileType });

describe('re-tagging an attachment', () => {
  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    adminToken = await loginAs('admin@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('a payment proof uploaded as the prescription re-tags to prescription, and its verified stamp resets', async () => {
    const o = await orderAt();
    const attachmentId = await addFile(o.id, { fileType: 'payment_proof', status: 'verified', name: 'actually-a-prescription.jpg' });

    const res = await retag(o.id, attachmentId, 'prescription');
    expect(res.status).toBe(200);
    const row = res.body.data.attachments.find((a) => a.id === attachmentId);
    expect(row.file_type).toBe('prescription');
    expect(row.status).toBe('pending');
    expect(row.verified_by).toBeNull();
    expect(row.verified_at).toBeNull();

    // It now shows up as a real prescription, from Pharmacy's own read of it.
    const dbRow = await db.prepare('SELECT * FROM payment_proofs WHERE id = ?').get(attachmentId);
    expect(dbRow.file_type).toBe('prescription');
    expect(dbRow.status).toBe('pending');

    const ev = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ATTACHMENT_RETAGGED'").get(o.id);
    expect(ev).toBeTruthy();
    expect(ev.notes).toMatch(/payment_proof to prescription/);
  });

  test('a rejected file loses its rejection reason on retag', async () => {
    const o = await orderAt();
    const attachmentId = await addFile(o.id, { fileType: 'id', status: 'rejected', name: 'blurry.jpg' });
    await db.prepare('UPDATE payment_proofs SET rejection_reason = ? WHERE id = ?').run('Not legible', attachmentId);

    const res = await retag(o.id, attachmentId, 'prescription');
    expect(res.status).toBe(200);
    const row = res.body.data.attachments.find((a) => a.id === attachmentId);
    expect(row.status).toBe('pending');
    expect(row.rejection_reason).toBeNull();
  });

  test('refused: same type, an unretaggable type, a MedRep, or a missing attachment', async () => {
    const o = await orderAt();
    const attachmentId = await addFile(o.id, { fileType: 'payment_proof', status: 'pending' });

    expect((await retag(o.id, attachmentId, 'payment_proof')).status).toBe(400);
    expect((await retag(o.id, attachmentId, 'other')).status).toBe(400);
    expect((await retag(o.id, attachmentId, 'prescription', medrepToken)).status).toBe(403);
    expect((await retag(o.id, 999999, 'prescription')).status).toBe(404);

    const otherType = await addFile(o.id, { fileType: 'other', status: 'pending', name: 'misc.pdf' });
    expect((await retag(o.id, otherType, 'prescription')).status).toBe(400);
  });

  test('admin may also retag', async () => {
    const o = await orderAt();
    const attachmentId = await addFile(o.id, { fileType: 'id', status: 'pending', name: 'id-or-rx.jpg' });
    expect((await retag(o.id, attachmentId, 'prescription', adminToken)).status).toBe(200);
  });
});
