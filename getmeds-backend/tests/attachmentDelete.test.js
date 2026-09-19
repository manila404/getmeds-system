/**
 * Sep 19, 2026 — a MedRep can ask for an attachment to be deleted, with a
 * note saying why; Management approves or declines before anything is
 * actually removed.
 *
 * "the only resubmits from medreps are only message... add them to add
 * attachments when management/finance restrain their order" — this is the
 * companion request: attachments were permanent once uploaded (no DELETE, no
 * soft-delete column, anywhere), so a MedRep who attached the wrong file had
 * no way to get rid of it. This does not delete anything by itself — it is
 * a request Management decides on, and local-only: a file already pushed to
 * the real Zoho Sales Order (zoho_pushed) is flagged, never removed there
 * automatically (this app has no delete-type Zoho write at all).
 */
jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...actual,
    createUploadUrl: jest.fn(async (storagePath) => ({
      signedUrl: `https://storage.test/object/upload/sign/pod/${storagePath}?token=fake`,
      token: 'fake',
      path: storagePath,
    })),
    createViewUrl: jest.fn(async (storagePath) => `https://storage.test/object/sign/pod/${storagePath}?token=fake`),
    createDownloadUrl: jest.fn(async (storagePath) => `https://storage.test/object/sign/pod/${storagePath}?token=fake&download`),
    removeQuietly: jest.fn(async () => true),
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const proofStorage = require('../src/services/paymentProofStorage');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const JPEG = { contentType: 'image/jpeg', fileName: 'wrong-invoice.jpg', fileSize: 2 * 1024 * 1024 };

describe('attachment deletion request/approval', () => {
  let ownerToken, otherRepToken, managerToken, financeToken;
  let ownerId, customerId;
  const createdOrderIds = [];
  const createdUserIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    managerToken = await loginAs('manager@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');

    const owner = await db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    ownerId = owner.id;

    const other = await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'medrep')")
      .run('Attach Delete Other Rep', 'attach-delete-other-rep@getmeds.ph', owner.password_hash);
    createdUserIds.push(other.lastInsertRowid);
    otherRepToken = await loginAs('attach-delete-other-rep@getmeds.ph');

    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  async function makeOrder() {
    const ref = `ADTEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 1500, '1 Delete St')`
      )
      .run(ref, customerId, ownerId)).lastInsertRowid;
    createdOrderIds.push(id);
    return id;
  }

  /** Walk the real upload handshake so the row is a genuine one, not a raw INSERT. */
  async function attach(orderId, token = ownerToken, file = JPEG) {
    const urlRes = await request(app).post(`/api/orders/${orderId}/attachments/upload-url`).set(auth(token)).send(file);
    const confirmRes = await request(app)
      .post(`/api/orders/${orderId}/attachments`)
      .set(auth(token))
      .send({ storagePath: urlRes.body.data.storagePath, ...file, file_type: 'other' });
    return confirmRes.body.data.id;
  }

  const requestDelete = (orderId, attachmentId, reason, token = ownerToken) =>
    request(app).post(`/api/orders/${orderId}/attachments/${attachmentId}/request-delete`).set(auth(token)).send({ reason });

  const decideDelete = (orderId, attachmentId, approved, note, token = managerToken) =>
    request(app).post(`/api/orders/${orderId}/attachments/${attachmentId}/decide-delete`).set(auth(token)).send({ approved, note });

  const listAttachments = async (orderId, token = ownerToken) =>
    (await request(app).get(`/api/orders/${orderId}/attachments`).set(auth(token))).body.data.attachments;

  test('the owning MedRep can request deletion with a reason', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);

    const res = await requestDelete(orderId, attachmentId, 'Wrong invoice — this belongs to a different order');
    expect(res.status).toBe(200);
    expect(res.body.data.deletion_status).toBe('requested');

    const row = await db.prepare('SELECT deletion_status, deletion_reason, deletion_requested_by FROM payment_proofs WHERE id = ?').get(attachmentId);
    expect(row.deletion_status).toBe('requested');
    expect(row.deletion_reason).toBe('Wrong invoice — this belongs to a different order');
    expect(row.deletion_requested_by).toBe(ownerId);

    const managerIds = (await db.prepare("SELECT id FROM users WHERE role = 'management'").all()).map((u) => u.id);
    const notes = await db.prepare('SELECT recipient_id, message FROM notifications WHERE order_id = ?').all(orderId);
    expect(notes.some((n) => managerIds.includes(n.recipient_id) && /Wrong invoice/.test(n.message))).toBe(true);
  });

  test('a reason is required', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    const res = await requestDelete(orderId, attachmentId, '   ');
    expect(res.status).toBe(400);
  });

  test('a MedRep who does not own the order is refused (403)', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    const res = await requestDelete(orderId, attachmentId, 'Not mine to ask about', otherRepToken);
    expect(res.status).toBe(403);
  });

  test('a second request while one is already pending is refused (409)', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'First reason');
    const res = await requestDelete(orderId, attachmentId, 'Second reason');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_REQUESTED');
  });

  test('the attachment stays fully visible while the request is pending — nothing is deleted yet', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'Duplicate upload');
    const attachments = await listAttachments(orderId);
    expect(attachments.some((a) => a.id === attachmentId)).toBe(true);
    expect(proofStorage.removeQuietly).not.toHaveBeenCalled();
  });

  test('Management approving actually removes it — soft-deleted, storage freed, requester notified', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'Duplicate upload');

    const res = await decideDelete(orderId, attachmentId, true, 'Confirmed duplicate, safe to remove.');
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    const row = await db.prepare('SELECT deletion_status, deleted_at, deletion_decision_note FROM payment_proofs WHERE id = ?').get(attachmentId);
    expect(row.deletion_status).toBe('approved');
    expect(row.deleted_at).not.toBeNull();
    expect(row.deletion_decision_note).toBe('Confirmed duplicate, safe to remove.');

    // Gone from the list everyone actually sees.
    const attachments = await listAttachments(orderId);
    expect(attachments.some((a) => a.id === attachmentId)).toBe(false);

    expect(proofStorage.removeQuietly).toHaveBeenCalled();

    const notes = await db.prepare('SELECT recipient_id, message FROM notifications WHERE order_id = ?').all(orderId);
    expect(notes.some((n) => n.recipient_id === ownerId && /was deleted as requested/.test(n.message))).toBe(true);
  });

  test('Management declining leaves the attachment exactly as it was, with the reason on record', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'Actually I want it gone');

    const res = await decideDelete(orderId, attachmentId, false, 'This is the required Guarantee Letter — keep it.');
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(false);

    const row = await db.prepare('SELECT deletion_status, deleted_at FROM payment_proofs WHERE id = ?').get(attachmentId);
    expect(row.deletion_status).toBe('rejected');
    expect(row.deleted_at).toBeNull();

    const attachments = await listAttachments(orderId);
    expect(attachments.some((a) => a.id === attachmentId)).toBe(true);
  });

  test('a rejected request can be asked again', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'First try');
    await decideDelete(orderId, attachmentId, false, 'Not this time');
    const res = await requestDelete(orderId, attachmentId, 'Second try, different reason');
    expect(res.status).toBe(200);
  });

  test('deciding with nothing pending is refused (409)', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    const res = await decideDelete(orderId, attachmentId, true, null);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AWAITING_DECISION');
  });

  test('a MedRep cannot decide a deletion request, even their own (403)', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'Please remove');
    const res = await decideDelete(orderId, attachmentId, true, null, ownerToken);
    expect(res.status).toBe(403);
  });

  test('Finance cannot decide a deletion request either (403)', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    await requestDelete(orderId, attachmentId, 'Please remove');
    const res = await decideDelete(orderId, attachmentId, true, null, financeToken);
    expect(res.status).toBe(403);
  });

  test('approving a file already pushed to Zoho flags it, and says so on the trail — never touches Zoho itself', async () => {
    const orderId = await makeOrder();
    const attachmentId = await attach(orderId);
    // This order never got a zoho_so_id, so the real upload path could not
    // have pushed it — set the flag directly to exercise the branch.
    await db.prepare('UPDATE payment_proofs SET zoho_pushed = true WHERE id = ?').run(attachmentId);
    await db.prepare("UPDATE orders SET zoho_so_id = 'SO-TEST-1', zoho_so_number = 'SO-00099' WHERE id = ?").run(orderId);
    await requestDelete(orderId, attachmentId, 'Wrong file');

    const res = await decideDelete(orderId, attachmentId, true, null);
    expect(res.status).toBe(200);
    expect(res.body.data.stillOnZoho).toBe(true);
    expect(res.body.data.zohoSoNumber).toBe('SO-00099');

    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ATTACHMENT_DELETED'").get(orderId);
    expect(ev.notes).toMatch(/still on Zoho Sales Order SO-00099/);
  });
});
