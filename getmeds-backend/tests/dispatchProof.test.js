/**
 * Sep 15, 2026 — Dispatch uploads a proof photo; it goes to the Zoho Sales
 * Order and the MedRep who created the order is told.
 *
 * Storage is faked the same way as tests/paymentProof.test.js: only the calls
 * that talk to Supabase. Path building and upload validation are the real ones.
 */
jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...actual,
    createUploadUrl: jest.fn(async (storagePath) => ({
      signedUrl: `https://storage.test/object/upload/sign/pod/${storagePath}?token=fake`,
      token: 'fake',
      path: storagePath
    })),
    downloadFile: jest.fn(async () => Buffer.from('fake-jpeg-bytes'))
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const created = [];
let dispatchToken;
let medrepToken;
let medrepId;
let customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function orderAt(status) {
  const ref = `GM-PROOF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, zoho_so_id, zoho_so_number)
       VALUES (?, ?, ?, ?, 'credit', 7200, '1 Proof St', ?, 'SO-67465')`
    )
    .run(ref, customerId, medrepId, status, `ZSO-${ref}`);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  return row;
}

/** The two API calls of an upload (the PUT to storage sits between them in the browser). */
async function upload(orderId, token, fileType = 'dispatch_proof') {
  const meta = { contentType: 'image/jpeg', fileName: 'parcel.jpg', fileSize: 2048, file_type: fileType };
  const url = await request(app).post(`/api/orders/${orderId}/attachments/upload-url`).set(auth(token)).send(meta);
  if (url.status !== 200) return url;
  return request(app)
    .post(`/api/orders/${orderId}/attachments`)
    .set(auth(token))
    .send({ ...meta, storagePath: url.body.data.storagePath });
}

describe('Dispatch proof photo', () => {
  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('goes onto the Zoho Sales Order, and the MedRep is told', async () => {
    const order = await orderAt('ready_for_dispatch');
    const spy = jest.spyOn(zoho, 'addSalesOrderAttachment').mockResolvedValue({ code: 0 });
    let res;
    try {
      res = await upload(order.id, dispatchToken);
      expect(res.status).toBe(200);
      expect(res.body.data.zoho_pushed).toBe(true);
      expect(spy).toHaveBeenCalledWith(order.zoho_so_id, expect.objectContaining({ filename: 'parcel.jpg', contentType: 'image/jpeg' }));
    } finally {
      spy.mockRestore();
    }

    const row = await db.prepare('SELECT file_type FROM payment_proofs WHERE order_id = ?').get(order.id);
    expect(row.file_type).toBe('dispatch_proof');
    const events = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'DISPATCH_PROOF_UPLOADED'").all(order.id);
    expect(events).toHaveLength(1);
    const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, medrepId);
    expect(note.message).toMatch(/Dispatch uploaded a proof photo.*attached to SO-67465 in Zoho/);
    // A record, not a stage.
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('ready_for_dispatch');
  });

  test('if Zoho refuses, the photo is still kept and the MedRep is told it is not in Zoho yet', async () => {
    const order = await orderAt('dispatched');
    const spy = jest.spyOn(zoho, 'addSalesOrderAttachment').mockRejectedValue(new Error('Maximum 10 files allowed'));
    try {
      const res = await upload(order.id, dispatchToken);
      expect(res.status).toBe(200);
      expect(res.body.data.zoho_pushed).toBe(false);
      expect(res.body.data.zoho_error).toMatch(/Maximum 10 files/);
    } finally {
      spy.mockRestore();
    }
    expect(await db.prepare('SELECT id FROM payment_proofs WHERE order_id = ?').get(order.id)).toBeTruthy();
    const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, medrepId);
    expect(note.message).toMatch(/could not be attached in Zoho yet/);
  });

  test('Dispatch attaches nothing else, and a MedRep cannot attach a dispatch proof', async () => {
    const order = await orderAt('ready_for_dispatch');
    const asDispatch = await upload(order.id, dispatchToken, 'payment_proof');
    expect(asDispatch.status).toBe(403);
    expect(asDispatch.body.error.message).toMatch(/only attach a dispatch proof/);
    const asRep = await upload(order.id, medrepToken, 'dispatch_proof');
    expect(asRep.status).toBe(403);
  });

  test('not before Finance has confirmed the order', async () => {
    const order = await orderAt('ready_for_finance_verified');
    const res = await upload(order.id, dispatchToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AT_DISPATCH');
  });
});
