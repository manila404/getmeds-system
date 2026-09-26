/**
 * Sep 26, 2026 — opening an attachment must open THAT attachment.
 *
 * GM-20260926-0021: clicking the Valid ID opened the InstaPay receipt. The Valid ID
 * was the order's newest row by our id, so it was "eligible" to be read back from
 * Zoho, but Zoho's GET returns ITS newest attachment whatever document_id is asked
 * for, and Zoho's newest was the receipt (its pushes landed out of order).
 *
 * The view now checks what Zoho returned against the file it holds (name or size)
 * and serves its own stored copy when they do not match.
 */
jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return { ...actual, downloadFile: jest.fn(async () => Buffer.from('OUR-OWN-COPY')) };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const proofStorage = require('../src/services/paymentProofStorage');
const attachmentLink = require('../src/services/attachmentLinkService');

let orderId, customerId, medrepId, proofId;

const insertProof = async (name, size, docId) => {
  await db
    .prepare(
      `INSERT INTO payment_proofs (order_id, file_type, file_name, content_type, file_size, storage_path, uploaded_by, uploaded_at, status, zoho_pushed, zoho_document_id)
       VALUES (?, 'id', ?, 'image/png', ?, ?, ?, ?, 'pending', true, ?)`
    )
    .run(orderId, name, size, `orders/${orderId}/payment_proof/${name}`, medrepId, new Date().toISOString(), docId);
  return (await db.prepare('SELECT id FROM payment_proofs WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId)).id;
};

describe('attachment view', () => {
  beforeAll(async () => {
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const ref = `GM-VIEW-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, submitted_at, zoho_so_id)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 100, '1 View St', ?, 'SO-VIEW-1')`
      )
      .run(ref, customerId, medrepId, new Date().toISOString());
    orderId = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
    proofId = await insertProof('pasted-valid-id.png', 356279, 'DOC-1');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  const view = () => request(app).get(`/api/attachment-view?token=${attachmentLink.sign(proofId, orderId)}`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  test('Zoho hands back a DIFFERENT file: our own stored copy is served instead', async () => {
    jest.spyOn(zoho, 'getSalesOrderAttachment').mockResolvedValue({
      buffer: Buffer.from('THE-INSTAPAY-RECEIPT'), contentType: 'image/jpeg', fileName: 'IMG_6590.jpeg',
    });
    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('OUR-OWN-COPY');
    expect(proofStorage.downloadFile).toHaveBeenCalled();
  });

  test('Zoho hands back this very file (same name): it is served from Zoho as before', async () => {
    proofStorage.downloadFile.mockClear();
    jest.spyOn(zoho, 'getSalesOrderAttachment').mockResolvedValue({
      buffer: Buffer.from('FROM-ZOHO'), contentType: 'image/png', fileName: 'pasted-valid-id.png',
    });
    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('FROM-ZOHO');
    expect(proofStorage.downloadFile).not.toHaveBeenCalled();
  });

  test('a renamed file of the same size still counts as the same file', async () => {
    proofStorage.downloadFile.mockClear();
    jest.spyOn(zoho, 'getSalesOrderAttachment').mockResolvedValue({
      buffer: Buffer.alloc(356279, 1), contentType: 'image/png', fileName: 'renamed-by-zoho.png',
    });
    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(356279);
    expect(proofStorage.downloadFile).not.toHaveBeenCalled();
  });
});
