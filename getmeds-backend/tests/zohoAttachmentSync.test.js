/**
 * Sep 21, 2026 — "all attachments should enter in Zoho Sales Order, only
 * attachments uploaded by the Dispatch only get in."
 *
 * paymentProof.controller.js's attach already pushes a NEW upload straight to
 * the Zoho Sales Order's own "Attach File(s)" section — but only once the
 * order already has a zoho_so_id. A MedRep almost always attaches proof of
 * payment while the order is still a draft/pending-approval, well before
 * Management approves it and a Sales Order gets created in Zoho — so that
 * push was silently skipped, and nothing ever came back for it. Only
 * Dispatch's proof (always attached long after the Sales Order exists)
 * reliably reached Zoho, which is exactly the bug reported.
 *
 * zohoAttachmentSync.pushUnsyncedAttachments is the catch-up pass, called the
 * moment a Sales Order first exists (orders.controller.js's
 * syncOrderToZohoAndFinalize, and zohoRetryService's own retry success).
 */
jest.mock('../src/services/paymentProofStorage', () => {
  const actual = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...actual,
    downloadFile: jest.fn(async () => Buffer.from('fake file bytes')),
  };
});

const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const proofStorage = require('../src/services/paymentProofStorage');
const zohoRetryService = require('../src/services/zohoRetryService');
const { pushUnsyncedAttachments } = require('../src/services/zohoAttachmentSync');

describe('zohoAttachmentSync.pushUnsyncedAttachments', () => {
  let medrepId;
  let customerId;
  const createdOrderIds = [];

  beforeAll(async () => {
    const medrep = await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get();
    medrepId = medrep.id;
    customerId = (await db.prepare(
      `INSERT INTO customers (name, type, credit_limit, is_active) VALUES (?, 'direct', 0, 1)`
    ).run('ZOHO-ATTACH-SYNC-TEST Customer')).lastInsertRowid;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare(`DELETE FROM customers WHERE id = ?`).run(customerId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    proofStorage.downloadFile.mockClear();
  });

  async function makeOrder(getmedsOrderId, { withSoId = false } = {}) {
    const now = new Date().toISOString();
    const result = await db.prepare(`
      INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
        delivery_address, zoho_so_id, zoho_sync_status, created_at, submitted_at, updated_at)
      VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 20, '1 Attach Sync St', ?, ?, ?, ?, ?)
    `).run(getmedsOrderId, customerId, medrepId, withSoId ? 'MOCK-SO-PRESEED' : null, withSoId ? 'synced' : 'pending', now, now, now);
    createdOrderIds.push(result.lastInsertRowid);
    return result.lastInsertRowid;
  }

  async function addProof(orderId, { pushed = false } = {}) {
    const now = new Date().toISOString();
    const result = await db.prepare(`
      INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, zoho_pushed, uploaded_at, created_at)
      VALUES (?, 'payment_proof', 'pending', ?, 'slip.jpg', 'image/jpeg', ?, ?, ?)
    `).run(orderId, `orders/${orderId}/payment_proof/slip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`, pushed, now, now);
    return result.lastInsertRowid;
  }

  test('pushes every not-yet-pushed local attachment onto the given Zoho Sales Order and marks each zoho_pushed', async () => {
    const orderId = await makeOrder('GM-ATTACHSYNC-0001');
    const proofA = await addProof(orderId);
    const proofB = await addProof(orderId);
    const alreadyPushed = await addProof(orderId, { pushed: true });

    // A real Sales Order in the mock adapter's own store, so
    // addSalesOrderAttachment resolves against a genuine id.
    const so = await zoho.createSalesOrder({
      getmeds_order_id: 'GM-ATTACHSYNC-0001',
      customer_name: 'ZOHO-ATTACH-SYNC-TEST Customer',
      customer_type: 'direct',
      total_amount: 20,
      delivery_address: '1 Attach Sync St',
      salesperson_name: 'TEST | MEDREP',
      items: []
    });

    const spy = jest.spyOn(zoho, 'addSalesOrderAttachment');
    const result = await pushUnsyncedAttachments(orderId, so.salesorder.salesorder_id);

    expect(result).toEqual({ pushed: 2, failed: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(proofStorage.downloadFile).toHaveBeenCalledTimes(2);

    const rows = await db.prepare('SELECT id, zoho_pushed FROM payment_proofs WHERE order_id = ? ORDER BY id').all(orderId);
    expect(rows.find((r) => r.id === proofA).zoho_pushed).toBe(true);
    expect(rows.find((r) => r.id === proofB).zoho_pushed).toBe(true);
    // Untouched — it was already pushed and should not be re-sent.
    expect(rows.find((r) => r.id === alreadyPushed).zoho_pushed).toBe(true);
  });

  test('one failing file does not block the rest, and is not marked pushed', async () => {
    const orderId = await makeOrder('GM-ATTACHSYNC-0002');
    await addProof(orderId);
    await addProof(orderId);

    const so = await zoho.createSalesOrder({
      getmeds_order_id: 'GM-ATTACHSYNC-0002',
      customer_name: 'ZOHO-ATTACH-SYNC-TEST Customer',
      customer_type: 'direct',
      total_amount: 20,
      delivery_address: '1 Attach Sync St',
      salesperson_name: 'TEST | MEDREP',
      items: []
    });

    jest.spyOn(zoho, 'addSalesOrderAttachment')
      .mockRejectedValueOnce(new Error('Zoho unreachable'))
      .mockImplementationOnce((...args) => jest.requireActual('../src/integrations/zoho').addSalesOrderAttachment(...args));

    const result = await pushUnsyncedAttachments(orderId, so.salesorder.salesorder_id);
    expect(result).toEqual({ pushed: 1, failed: 1 });

    const rows = await db.prepare('SELECT zoho_pushed FROM payment_proofs WHERE order_id = ? ORDER BY id').all(orderId);
    expect(rows.map((r) => r.zoho_pushed).sort()).toEqual([false, true]);
  });

  test('no order id or Sales Order id: a no-op, nothing pushed', async () => {
    const orderId = await makeOrder('GM-ATTACHSYNC-0003');
    await addProof(orderId);
    const spy = jest.spyOn(zoho, 'addSalesOrderAttachment');

    expect(await pushUnsyncedAttachments(orderId, null)).toEqual({ pushed: 0, failed: 0 });
    expect(await pushUnsyncedAttachments(null, 'MOCK-SO-123')).toEqual({ pushed: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  test('zohoRetryService: a successful retry catches up attachments gathered while the order sat in the queue', async () => {
    const orderId = await makeOrder('GM-ATTACHSYNC-0004');
    const proofId = await addProof(orderId);

    await zohoRetryService.enqueue({
      orderId,
      payload: {
        getmeds_order_id: 'GM-ATTACHSYNC-0004',
        customer_name: 'ZOHO-ATTACH-SYNC-TEST Customer',
        customer_type: 'direct',
        total_amount: 20,
        delivery_address: '1 Attach Sync St',
        items: []
      },
      error: 'Zoho API is down'
    });

    const spy = jest.spyOn(zoho, 'addSalesOrderAttachment');
    const results = await zohoRetryService.processQueue({ force: true });
    const result = results.find((r) => r.orderId === orderId);
    expect(result.outcome).toBe('succeeded');
    expect(spy).toHaveBeenCalledTimes(1);

    const proof = await db.prepare('SELECT zoho_pushed FROM payment_proofs WHERE id = ?').get(proofId);
    expect(proof.zoho_pushed).toBe(true);
  });
});
