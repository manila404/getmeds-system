/**
 * Proof of payment — attaching it, and how it rides on Finance's existing
 * account check.
 *
 * Sep 4, 2026.
 *
 * ── The claim these tests defend ───────────────────────────────────────────
 *
 * A proof of payment is EVIDENCE for the decision at
 * `ready_for_finance_verified`, not a decision of its own. So:
 *
 *   - approving happens inside POST /api/finance/orders/:id/verify, in the
 *     same transaction that moves the order. There is no approve endpoint for
 *     the proof, and the tests below check the two move together.
 *   - a missing proof never blocks that decision. It is a soft gate, for the
 *     same reason 2026-09-01-finance-verification.md gives for the account
 *     check: this app cannot stop anyone invoicing directly in Zoho, so
 *     refusing here would strand the order while Zoho carried on.
 *   - holding an order does NOT reject its proof. Those are different
 *     judgements about different things.
 *
 * ── What is mocked ─────────────────────────────────────────────────────────
 *
 * Only the three functions in services/paymentProofStorage.js that talk to
 * Supabase. buildPath, pathPrefixFor and validateUpload are the REAL ones,
 * because they decide where a file may land and what is accepted at all —
 * mocking the whole module would test the mock. Nothing here uploads a byte;
 * the file never passes through this API in production either.
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
const JPEG = { contentType: 'image/jpeg', fileName: 'deposit-slip.jpg', fileSize: 2 * 1024 * 1024 };

describe('proof of payment', () => {
  let ownerToken, otherRepToken, financeToken, dispatchToken, adminToken;
  let ownerId, customerId, productId;
  const createdOrderIds = [];
  const createdUserIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    adminToken = await loginAs('admin@getmeds.ph');

    const owner = await db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    ownerId = owner.id;

    // A SECOND MedRep, so "not your order" can be proved rather than assumed.
    // Reusing the seeded rep's bcrypt hash means loginAs works with the same
    // password without this file needing bcryptjs.
    const other = await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'medrep')")
      .run('Proof Other Rep', 'proof-other-rep@getmeds.ph', owner.password_hash);
    createdUserIds.push(other.lastInsertRowid);
    otherRepToken = await loginAs('proof-other-rep@getmeds.ph');

    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    productId = (await db.prepare('SELECT id FROM products LIMIT 1').get()).id;
  });

  afterAll(async () => {
    // payment_proofs, order_events and notifications all cascade from orders.
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  /**
   * Own fixtures rather than the shared floor — see the note at the bottom of
   * tests/globalSetup.js. Default status is where Finance actually decides.
   */
  async function makeOrder(status = 'ready_for_finance_verified') {
    const ref = `PPTEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const id = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address)
         VALUES (?, ?, ?, ?, 'direct', 1500, '1 Proof St')`
      )
      .run(ref, customerId, ownerId, status)).lastInsertRowid;
    createdOrderIds.push(id);
    return id;
  }

  /** Walk the full handshake the browser performs. */
  async function attachProof(token, id, file = JPEG) {
    const urlRes = await request(app).post(`/api/orders/${id}/payment-proof/upload-url`).set(auth(token)).send(file);
    if (urlRes.status !== 200) return { urlRes };
    const confirmRes = await request(app)
      .post(`/api/orders/${id}/payment-proof`)
      .set(auth(token))
      .send({ storagePath: urlRes.body.data.storagePath, ...file });
    return { urlRes, confirmRes, storagePath: urlRes.body.data.storagePath };
  }

  const eventsOf = (orderId, type) =>
    db.prepare('SELECT * FROM order_events WHERE order_id = ? AND event_type = ?').all(orderId, type);
  const proofOf = (orderId) => db.prepare('SELECT * FROM payment_proofs WHERE order_id = ?').get(orderId);
  const orderOf = (orderId) => db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  // ── who may attach ────────────────────────────────────────────────────────

  test('a MedRep who does not own the order is refused (403), and no URL is minted', async () => {
    const orderId = await makeOrder();
    proofStorage.createUploadUrl.mockClear();

    const res = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(otherRepToken))
      .send(JPEG);

    expect(res.status).toBe(403);
    // Checking before minting matters: a signed URL is a capability, and
    // issuing one to a caller who is then refused at step 3 would let them
    // write into another order's folder in the bucket.
    expect(proofStorage.createUploadUrl).not.toHaveBeenCalled();
  });

  /**
   * Sep 11, 2026. The regression behind GM-20260911-0003.
   *
   * A MedRep may raise an order for a colleague, which makes `medrep_id` the
   * COLLEAGUE's. The rep who filled the form in was then a stranger to their
   * own order the instant the browser tried to upload the file attached to
   * it: the order saved, the file did not, and the only sign was a red toast.
   *
   * The same gap was already closed once for management (Sep 5) and reopened
   * when the on-behalf flow was extended to reps — which is why it is pinned
   * here rather than left to the permission function's comment.
   */
  describe('an order raised on behalf of a colleague', () => {
    /** Mirrors what orders.controller.js writes on the submit event. */
    async function makeOrderRaisedBy(raiserId) {
      const orderId = await makeOrder();
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, actor_id, notes, metadata)
           VALUES (?, 'STATUS_CHANGE', ?, 'raised on behalf', ?)`
        )
        .run(orderId, ownerId, JSON.stringify({ onBehalfOf: true, raisedByUserId: raiserId }));
      return orderId;
    }

    test('the rep who raised it can attach, though they do not own it', async () => {
      const other = await db
        .prepare('SELECT id FROM users WHERE email = ?')
        .get('proof-other-rep@getmeds.ph');
      const orderId = await makeOrderRaisedBy(other.id);

      const { urlRes, confirmRes } = await attachProof(otherRepToken, orderId);

      expect(urlRes.status).toBe(200);
      expect(confirmRes.status).toBe(200);
      expect(proofOf(orderId)).toBeTruthy();
    });

    test('a rep named by no such trail is still refused', async () => {
      // Narrowness is the point: admitting the raiser must not become
      // admitting any rep who happens to be looking at the order.
      const orderId = await makeOrderRaisedBy(999999);

      const res = await request(app)
        .post(`/api/orders/${orderId}/payment-proof/upload-url`)
        .set(auth(otherRepToken))
        .send(JPEG);

      expect(res.status).toBe(403);
    });
  });

  test('an admin may attach to any order', async () => {
    const orderId = await makeOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(adminToken))
      .send(JPEG);
    expect(res.status).toBe(200);
  });

  // ── what may be attached ──────────────────────────────────────────────────

  test('an unsupported content type is refused (400) before any URL is minted', async () => {
    const orderId = await makeOrder();
    proofStorage.createUploadUrl.mockClear();

    const res = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(ownerToken))
      .send({ contentType: 'application/zip', fileName: 'slip.zip', fileSize: 1000 });

    expect(res.status).toBe(400);
    expect(proofStorage.createUploadUrl).not.toHaveBeenCalled();
  });

  test('a file over the size cap is refused (400)', async () => {
    // Trusts a client-declared size, so this is a UX guard rather than a
    // security control — the real ceiling is the bucket's own limit, which the
    // browser's PUT hits regardless of what was declared here.
    const orderId = await makeOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(ownerToken))
      .send({ contentType: 'image/jpeg', fileName: 'huge.jpg', fileSize: 16 * 1024 * 1024 });
    expect(res.status).toBe(400);
  });

  test('the minted path is scoped to the order, whatever the client called the file', async () => {
    const orderId = await makeOrder();
    const res = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(ownerToken))
      .send({ contentType: 'image/jpeg', fileName: '../../../etc/passwd.jpg', fileSize: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data.storagePath.startsWith(`orders/${orderId}/`)).toBe(true);
    expect(res.body.data.storagePath).not.toMatch(/\.\./);
  });

  test('confirming a path that belongs to another order is refused (400)', async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    const res = await request(app)
      .post(`/api/orders/${a}/payment-proof`)
      .set(auth(ownerToken))
      .send({ storagePath: `orders/${b}/sneaky.jpg`, ...JPEG });
    expect(res.status).toBe(400);
  });

  // ── attaching ─────────────────────────────────────────────────────────────

  test('attaching records a pending proof and logs PAYMENT_PROOF_UPLOADED', async () => {
    const orderId = await makeOrder();
    const { confirmRes, storagePath } = await attachProof(ownerToken, orderId);

    expect(confirmRes.status).toBe(200);
    const proof = await proofOf(orderId);
    expect(proof.status).toBe('pending');
    expect(proof.storage_path).toBe(storagePath);
    expect(proof.uploaded_by).toBe(ownerId);
    expect((await eventsOf(orderId, 'PAYMENT_PROOF_UPLOADED')).length).toBe(1);
  });

  test('Finance is notified only when the order is actually on their desk', async () => {
    const financeUser = await db.prepare('SELECT id FROM users WHERE email = ?').get('finance@getmeds.ph');

    const waiting = await makeOrder('ready_for_finance_verified');
    await attachProof(ownerToken, waiting);
    const notified = await db
      .prepare('SELECT * FROM notifications WHERE order_id = ? AND recipient_id = ?')
      .all(waiting, financeUser.id);
    expect(notified.length).toBeGreaterThan(0);

    // A proof attached while the order is still a draft is not something
    // anyone needs to act on yet.
    const draft = await makeOrder('draft');
    await attachProof(ownerToken, draft);
    const quiet = await db
      .prepare('SELECT * FROM notifications WHERE order_id = ? AND recipient_id = ?')
      .all(draft, financeUser.id);
    expect(quiet.length).toBe(0);
  });

  test('reading it back returns a freshly signed view URL that is NOT what is stored', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    const res = await request(app).get(`/api/orders/${orderId}/payment-proof`).set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.proof.viewUrl).toMatch(/^https:\/\/storage\.test\//);

    // The database holds an object key, never a URL — a leaked row is not a
    // leaked file, and the link cannot outlive its signature.
    const stored = await proofOf(orderId);
    expect(stored.storage_path).not.toMatch(/^https?:/);
    expect(stored.storage_path).not.toMatch(/token=/);
  });

  test('an order with no proof returns 404, and so does an unknown order', async () => {
    const orderId = await makeOrder();
    expect((await request(app).get(`/api/orders/${orderId}/payment-proof`).set(auth(ownerToken))).status).toBe(404);
    expect(
      (await request(app).post('/api/orders/99999999/payment-proof/upload-url').set(auth(ownerToken)).send(JPEG)).status
    ).toBe(404);
  });

  // ── the decision: it rides on the ORDER's verification ────────────────────

  test('verifying the ORDER verifies its pending proof, in one call', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    const res = await request(app)
      .post(`/api/finance/orders/${orderId}/verify`)
      .set(auth(financeToken))
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentProofVerified).toBe(true);

    // Both moved, and they agree.
    expect((await orderOf(orderId)).status).toBe('ready_for_draft_invoice');
    const proof = await proofOf(orderId);
    expect(proof.status).toBe('verified');
    expect(proof.verified_by).not.toBeNull();

    // One decision, one event — not a second one for the proof.
    expect((await eventsOf(orderId, 'FINANCE_VERIFIED')).length).toBe(1);
    const meta = JSON.parse((await eventsOf(orderId, 'FINANCE_VERIFIED'))[0].metadata);
    expect(meta.paymentProofVerified).toBe(true);
    expect(meta.paymentProofPath).toBe(proof.storage_path);
  });

  test('a missing proof does NOT block verification — it is a soft gate', async () => {
    const orderId = await makeOrder();

    const res = await request(app)
      .post(`/api/finance/orders/${orderId}/verify`)
      .set(auth(financeToken))
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentProofVerified).toBe(false);
    expect((await orderOf(orderId)).status).toBe('ready_for_draft_invoice');

    // The trail records that there was no proof at the moment of the decision,
    // which is the audit value of a soft gate.
    const meta = JSON.parse((await eventsOf(orderId, 'FINANCE_VERIFIED'))[0].metadata);
    expect(meta.paymentProofVerified).toBe(false);
  });

  test('HOLDING an order leaves its proof pending — a hold is not a rejection of the slip', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    const res = await request(app)
      .post(`/api/finance/orders/${orderId}/verify`)
      .set(auth(financeToken))
      .send({ approved: false, reason: 'Customer has ₱48,000 overdue past 60 days' });

    expect(res.status).toBe(200);
    expect((await orderOf(orderId)).status).toBe('on_hold');

    // The hold was about the account, not the receipt. Marking a perfectly
    // good slip rejected would send the MedRep chasing the wrong thing.
    const proof = await proofOf(orderId);
    expect(proof.status).toBe('pending');
    expect(proof.rejection_reason).toBeNull();
  });

  // ── rejecting the proof alone ─────────────────────────────────────────────

  test('rejecting the proof records the reason and leaves the order where it is', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    const res = await request(app)
      .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
      .set(auth(financeToken))
      .send({ reason: '  Slip is for invoice INV-0042, not this order  ' });

    expect(res.status).toBe(200);
    const proof = await proofOf(orderId);
    expect(proof.status).toBe('rejected');
    expect(proof.rejection_reason).toBe('Slip is for invoice INV-0042, not this order'); // trimmed

    // The order has NOT been held — that is the whole point of this endpoint.
    expect((await orderOf(orderId)).status).toBe('ready_for_finance_verified');
    expect((await eventsOf(orderId, 'PAYMENT_PROOF_REJECTED')).length).toBe(1);
  });

  test('rejecting without a reason is refused (400) and changes nothing', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    for (const body of [{}, { reason: '   ' }]) {
      const res = await request(app)
        .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
        .set(auth(financeToken))
        .send(body);
      expect(res.status).toBe(400);
    }
    expect((await proofOf(orderId)).status).toBe('pending');
  });

  test('rejecting an already-decided proof is refused (409), with no second event', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);
    await request(app)
      .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
      .set(auth(financeToken))
      .send({ reason: 'Unreadable' });

    const again = await request(app)
      .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
      .set(auth(financeToken))
      .send({ reason: 'Unreadable' });

    expect(again.status).toBe(409);
    expect((await eventsOf(orderId, 'PAYMENT_PROOF_REJECTED')).length).toBe(1);
  });

  // ── re-upload ─────────────────────────────────────────────────────────────

  test('re-uploading after a rejection resets to pending and keeps ONE row', async () => {
    const orderId = await makeOrder();
    const first = await attachProof(ownerToken, orderId);
    await request(app)
      .post(`/api/orders/${orderId}/payment-proof/reject`.replace('/orders/', '/finance/orders/'))
      .set(auth(financeToken))
      .send({ reason: 'Amount does not match' });

    proofStorage.removeQuietly.mockClear();
    const { confirmRes } = await attachProof(ownerToken, orderId, {
      contentType: 'application/pdf',
      fileName: 'corrected-slip.pdf',
      fileSize: 900000,
    });
    expect(confirmRes.status).toBe(200);

    const proof = await proofOf(orderId);
    expect(proof.status).toBe('pending');
    expect(proof.verified_by).toBeNull();
    expect(proof.verified_at).toBeNull();
    expect(proof.rejection_reason).toBeNull();
    expect(proof.file_name).toBe('corrected-slip.pdf');
    expect((await db.prepare('SELECT * FROM payment_proofs WHERE order_id = ?').all(orderId)).length).toBe(1);

    // The superseded object is cleaned up, but only after the row is safely
    // written — a storage call cannot be rolled back.
    expect(proofStorage.removeQuietly).toHaveBeenCalledWith(first.storagePath);
  });

  test('a verified proof cannot be replaced, at either step (409)', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);
    await request(app).post(`/api/finance/orders/${orderId}/verify`).set(auth(financeToken)).send({ approved: true });

    const urlRes = await request(app)
      .post(`/api/orders/${orderId}/payment-proof/upload-url`)
      .set(auth(ownerToken))
      .send(JPEG);
    expect(urlRes.status).toBe(409);
    expect(urlRes.body.error.code).toBe('ALREADY_VERIFIED');

    // And directly at the confirm step, in case a caller kept an older URL.
    const confirmRes = await request(app)
      .post(`/api/orders/${orderId}/payment-proof`)
      .set(auth(ownerToken))
      .send({ storagePath: `orders/${orderId}/late.jpg`, ...JPEG });
    expect(confirmRes.status).toBe(409);
  });

  // ── access ────────────────────────────────────────────────────────────────

  test('a MedRep cannot reject a proof, and neither can dispatch (403)', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    for (const token of [ownerToken, dispatchToken]) {
      const res = await request(app)
        .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
        .set(auth(token))
        .send({ reason: 'nope' });
      expect(res.status).toBe(403);
    }
  });

  test('the Finance queue carries the proof, so a row needs no second request', async () => {
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);

    const res = await request(app).get('/api/finance/queue').set(auth(financeToken));
    expect(res.status).toBe(200);
    const row = res.body.data.orders.find((o) => o.id === orderId);
    expect(row).toBeDefined();
    expect(row.payment_proof_status).toBe('pending');
    expect(row.payment_proof_file_name).toBe('deposit-slip.jpg');
    expect(row.payment_proof_uploaded_by_name).toEqual(expect.any(String));
  });

  // ── the reason an order has no proof ──────────────────────────────────────

  test('an order can record WHY it has no proof of payment', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(ownerToken))
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1, rate: 10 }],
        delivery_address: '1 Reason St',
        customer_type: 'direct',
        no_payment_proof_reason: 'on_payment_terms',
        no_payment_proof_note: 'Net 30, PO on file',
      });

    expect(res.status).toBe(201);
    const id = res.body.data.order.id;
    createdOrderIds.push(id);

    const row = await orderOf(id);
    expect(row.no_payment_proof_reason).toBe('on_payment_terms');
    expect(row.no_payment_proof_note).toBe('Net 30, PO on file');
  });

  test('a reason outside the allowed set is rejected by the constraint', async () => {
    // The order form offers four values; anything else means a caller invented
    // one, and an un-countable free-text answer is exactly what the enum exists
    // to prevent (the division lesson from Sep 2).
    await expect(
      db.prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, no_payment_proof_reason)
         VALUES (?, ?, ?, 'draft', 'direct', 10, 'x', 'terms lol')`
      ).run(`PPBAD-${Date.now()}`, customerId, ownerId)
    ).rejects.toThrow();
  });

  test('the API still accepts an order with neither a proof nor a reason', async () => {
    // The requirement is a gate on the FORM, not on this endpoint. It has to
    // be: the proof uploads AFTER create because it needs the order id for its
    // storage path, so rejecting here would refuse every order that is about
    // to get one.
    const res = await request(app)
      .post('/api/orders')
      .set(auth(ownerToken))
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1, rate: 10 }],
        delivery_address: '2 Reason St',
        customer_type: 'direct',
      });

    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);
    const row = await orderOf(res.body.data.order.id);
    expect(row.no_payment_proof_reason).toBeNull();
  });

  // ── the design claim ──────────────────────────────────────────────────────

  test('a proof is a record: attaching and rejecting never move the order', async () => {
    // Only Finance's decision on the ORDER moves it, through the endpoint that
    // already did that. If this fails, the feature has grown into the pipeline
    // and the reasoning in paymentProof.controller.js's header no longer holds.
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);
    expect((await orderOf(orderId)).status).toBe('ready_for_finance_verified');

    await request(app)
      .post(`/api/finance/orders/${orderId}/payment-proof/reject`)
      .set(auth(financeToken))
      .send({ reason: 'Wrong slip' });
    expect((await orderOf(orderId)).status).toBe('ready_for_finance_verified');

    await attachProof(ownerToken, orderId);
    expect((await orderOf(orderId)).status).toBe('ready_for_finance_verified');

    const moves = await db
      .prepare('SELECT * FROM order_events WHERE order_id = ? AND old_status <> new_status')
      .all(orderId);
    expect(moves.length).toBe(0);
  });

  test('a verified proof does not make an order paid', async () => {
    // `payments` is Zoho's record of a Customer Payment and is what
    // orderCompletionService.js means by paid. This table is the customer's
    // CLAIM. Conflating them would complete orders nobody has been paid for.
    const orderId = await makeOrder();
    await attachProof(ownerToken, orderId);
    await request(app).post(`/api/finance/orders/${orderId}/verify`).set(auth(financeToken)).send({ approved: true });

    expect((await proofOf(orderId)).status).toBe('verified');
    expect(await db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId)).toBeUndefined();
    expect((await orderOf(orderId)).status).toBe('ready_for_draft_invoice');
  });
});
