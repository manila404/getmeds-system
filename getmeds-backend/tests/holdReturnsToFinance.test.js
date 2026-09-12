/**
 * A Finance hold ends when the thing it was waiting for arrives.
 *
 * Sep 12, 2026.
 *
 * ── What was broken ───────────────────────────────────────────────────────
 *
 * Finance holds an order for a missing proof of payment. The MedRep uploads
 * one. Nothing happened: the order stayed at 'on_hold' and Finance was never
 * told, because the notification only fired for orders already sitting at
 * 'ready_for_finance_verified'. The transition back was legal in the state
 * machine the entire time — nothing ever triggered it.
 *
 * Order 60985 in production is the case: held with "Please provide proof of
 * payment", then three PAYMENT_PROOF_UPLOADED events in a row, every one of
 * them 'on_hold -> on_hold'. The rep did what was asked, saw nothing change,
 * and did it again. Twice.
 *
 * ── Why it is narrow ──────────────────────────────────────────────────────
 *
 * 'on_hold' is reachable from eight statuses, and the warehouse and Management
 * set it too. Returning every held order to Finance on an upload would drag a
 * picking-and-packing hold backwards through the pipeline. So the order only
 * goes back when the hold it is under was applied FROM
 * 'ready_for_finance_verified'. Both halves are tested — the bounce and the
 * refusal to bounce — because the second is the one a careless fix loses.
 */

jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...actual,
    createUploadUrl: jest.fn(async (storagePath) => ({
      signedUrl: `https://storage.test/upload/${storagePath}`,
      token: 'fake',
      path: storagePath,
    })),
    createViewUrl: jest.fn(async (p) => `https://storage.test/view/${p}`),
    downloadFile: jest.fn(async () => Buffer.from('x')),
    removeQuietly: jest.fn(async () => true),
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const JPEG = { contentType: 'image/jpeg', fileName: 'deposit-slip.jpg', fileSize: 1024 };

describe('an order held by Finance for a missing proof of payment', () => {
  let ownerToken;
  let ownerId, customerId;
  const createdOrderIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    ownerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('medrep@getmeds.ph')).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  /** An order sitting on hold, with a trail saying which status it was held from. */
  async function heldOrder(heldFrom) {
    const ref = `HOLD-${heldFrom}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                             customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'on_hold', 'direct', 1500, '1 Hold St')`
      )
      .run(ref, customerId, ownerId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);

    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, notes)
         VALUES (?, 'FINANCE_REJECTED', ?, 'on_hold', ?, 'held for the test')`
      )
      .run(id, heldFrom, ownerId);
    return id;
  }

  async function attachProof(orderId) {
    const urlRes = await request(app)
      .post(`/api/orders/${orderId}/attachments/upload-url`)
      .set(auth(ownerToken))
      .send({ ...JPEG, file_type: 'payment_proof' });
    expect(urlRes.status).toBe(200);

    return request(app)
      .post(`/api/orders/${orderId}/attachments`)
      .set(auth(ownerToken))
      .send({ storagePath: urlRes.body.data.storagePath, ...JPEG, file_type: 'payment_proof' });
  }

  const statusOf = async (id) =>
    (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;

  test('uploading the proof returns it to Finance', async () => {
    const id = await heldOrder('ready_for_finance_verified');
    expect(await statusOf(id)).toBe('on_hold');

    const res = await attachProof(id);
    expect(res.status).toBe(200);

    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });

  test('the trail says why it moved', async () => {
    // The status changed without anyone pressing a button that says so, which
    // is exactly when the timeline has to explain itself.
    const id = await heldOrder('ready_for_finance_verified');
    await attachProof(id);

    const ev = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'RETURNED_TO_FINANCE'")
      .get(id);
    expect(ev).toBeTruthy();
    expect(ev.old_status).toBe('on_hold');
    expect(ev.new_status).toBe('ready_for_finance_verified');
    expect(ev.notes).toMatch(/proof of payment/i);
  });

  test('it then appears on the Finance screen as awaiting confirmation', async () => {
    // The point of the whole fix: the order is back where someone will see it.
    const id = await heldOrder('ready_for_finance_verified');
    await attachProof(id);

    const financeToken = await loginAs('finance@getmeds.ph');
    const res = await request(app)
      .get('/api/finance/queue?stage=actionable&limit=100')
      .set(auth(financeToken));
    expect(res.status).toBe(200);
    expect(res.body.data.orders.map((o) => o.id)).toContain(id);
  });

  test('a hold applied further down the pipeline is NOT dragged back', async () => {
    // The half a careless fix loses. A warehouse hold is not Finance's, and an
    // upload must not pull the order backwards through the pipeline.
    const id = await heldOrder('picking_packing');

    const res = await attachProof(id);
    expect(res.status).toBe(200);

    expect(await statusOf(id)).toBe('on_hold');
  });

  test('any attachment type reopens it, not only a proof of payment', async () => {
    // Finance's hold reason is free text, so the file type cannot be matched
    // against it. An order held for a missing Guarantee Letter has to reopen
    // on the Guarantee Letter.
    const id = await heldOrder('ready_for_finance_verified');

    const urlRes = await request(app)
      .post(`/api/orders/${id}/attachments/upload-url`)
      .set(auth(ownerToken))
      .send({ ...JPEG, file_type: 'gl' });
    await request(app)
      .post(`/api/orders/${id}/attachments`)
      .set(auth(ownerToken))
      .send({ storagePath: urlRes.body.data.storagePath, ...JPEG, file_type: 'gl' });

    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });

  test('correcting the line items reopens it', async () => {
    // The other update a held order can actually receive. updateDetails is
    // deliberately not covered: it refuses anything but draft /
    // pending_management_approval, so it can never see a held order.
    const id = await heldOrder('ready_for_finance_verified');
    const product = await db.prepare('SELECT id FROM products LIMIT 1').get();

    const res = await request(app)
      .patch(`/api/orders/${id}/items`)
      .set(auth(ownerToken))
      .send({ items: [{ product_id: product.id, quantity: 2, unit_price: 750 }] });
    expect(res.status).toBe(200);

    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });
});
