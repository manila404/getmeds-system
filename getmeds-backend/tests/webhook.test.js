const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

describe('Zoho Webhook Receiver — POST /api/webhooks/zoho', () => {
  let testOrderId;
  const testOrderNumber = 'GM-WH-TEST-0001';
  const testZohoSoId = 'ZOHO-SO-WH-12345';
  let medrepUser;
  let customer;

  beforeAll(async () => {
    medrepUser = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    customer = await db.prepare("SELECT id FROM customers WHERE type = 'direct' LIMIT 1").get();
  });

  beforeEach(async () => {
    const existing = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(testOrderNumber);
    if (existing) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    const result = await db.prepare(`
      INSERT INTO orders (
        getmeds_order_id, customer_id, medrep_id, status, customer_type,
        total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status
      ) VALUES (?, ?, ?, 'ready_for_draft_invoice', 'direct', 1500.00, '123 Test Street, Manila', ?, 'SO-99999', 'synced')
    `).run(testOrderNumber, customer.id, medrepUser.id, testZohoSoId);
    testOrderId = result.lastInsertRowid;
  });

  afterAll(async () => {
    if (testOrderId) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(testOrderId);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(testOrderId);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(testOrderId);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(testOrderId);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(testOrderId);
    }
  });

  test('Webhook authentication: rejects invalid token when ZOHO_WEBHOOK_SECRET is set', async () => {
    const originalSecret = process.env.ZOHO_WEBHOOK_SECRET;
    process.env.ZOHO_WEBHOOK_SECRET = 'super-secure-token';
    try {
      const res = await request(app)
        .post('/api/webhooks/zoho')
        .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: testZohoSoId } });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');

      const authRes = await request(app)
        .post('/api/webhooks/zoho')
        .set('X-Zoho-Webhook-Token', 'super-secure-token')
        .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: testZohoSoId } });
      expect(authRes.status).toBe(200);
      expect(authRes.body.success).toBe(true);
    } finally {
      process.env.ZOHO_WEBHOOK_SECRET = originalSecret || '';
    }
  });

  test('Gracefully handles unmapped order without error', async () => {
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: 'NON_EXISTENT_SO_99999' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.processed).toBe(false);
  });

  test('Processes payment.created / invoice.paid: records the money without moving the pipeline', async () => {
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'payment.created',
        payment: { salesorder_id: testZohoSoId, payment_number: 'PAY-ZOHO-9988', amount: 1500.00, date: '2026-08-26' }
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.processed).toBe(true);
    expect(res.body.action).toBe('PAYMENT_VERIFIED');
    // Sep 1, 2026 (5): payment moves nothing. It used to push the order to
    // ready_for_dispatch, which made sense while that meant "Sales Order
    // confirmed, go pack" — it now means "the invoice has been issued", and
    // jumping there because money arrived would skip both Finance stages and
    // tell the warehouse to pack something that was never invoiced.
    expect(res.body.new_status).toBe('ready_for_draft_invoice');
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('ready_for_draft_invoice');
    const payment = await db.prepare('SELECT * FROM payments WHERE order_id = ?').get(testOrderId);
    expect(payment).toBeDefined();
    expect(payment.status).toBe('verified');
    expect(payment.payment_reference).toBe('PAY-ZOHO-9988');
  });

  test('Processes shipment.created: updates dispatch_records and advances to tracking_shared', async () => {
    await db.prepare("UPDATE orders SET status = 'ready_for_dispatch' WHERE id = ?").run(testOrderId);
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'shipment.created',
        shipment: { salesorder_id: testZohoSoId, tracking_number: 'LBC-PH-99228811', carrier: 'LBC Express' }
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('DISPATCHED_WITH_TRACKING');
    // Sep 1, 2026: shipping alone no longer finishes an order — it stops at
    // tracking_shared and waits for the payment half of the rule.
    expect(res.body.new_status).toBe('tracking_shared');
    const dispatch = await db.prepare('SELECT * FROM dispatch_records WHERE order_id = ?').get(testOrderId);
    expect(dispatch.tracking_number).toBe('LBC-PH-99228811');
  });

  test('Processes invoice.sent: moves invoice_drafted → invoice_sent (not a duplicate "drafted")', async () => {
    await db.prepare("UPDATE orders SET status = 'ready_for_invoice_sent' WHERE id = ?").run(testOrderId);
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'invoice.sent',
        invoice: { salesorder_id: testZohoSoId, invoice_id: 'INV-Z-771', invoice_number: 'INV-000771', status: 'sent' }
      });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('INVOICE_SENT');
    expect(res.body.new_status).toBe('ready_for_dispatch');

    const order = await db.prepare('SELECT status, zoho_invoice_number FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('ready_for_dispatch');
    expect(order.zoho_invoice_number).toBe('INV-000771');

    // The bug this branch was written to kill: a "sent" invoice used to be
    // matched by the drafted check and logged as another INVOICE_DRAFTED.
    const drafted = await db
      .prepare("SELECT COUNT(*) as n FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_INVOICE_DRAFTED'")
      .get(testOrderId);
    expect(drafted.n).toBe(0);
  });

  test('Shipment then payment: payment arriving last completes the order', async () => {
    await db.prepare("UPDATE orders SET status = 'ready_for_dispatch' WHERE id = ?").run(testOrderId);

    await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'shipment.created',
        shipment: { salesorder_id: testZohoSoId, tracking_number: 'JRS-77120', carrier: 'JRS Express' }
      });
    let order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('tracking_shared');

    // This is the case that used to dead-end: an order already shipped, then
    // paid on terms, stayed at tracking_shared forever because nothing in
    // the codebase assigned 'completed'.
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'payment.created',
        payment: { salesorder_id: testZohoSoId, payment_number: 'PAY-LAST-01', amount: 1500.0, date: '2026-09-01' }
      });
    expect(res.body.action).toBe('PAYMENT_VERIFIED_ORDER_COMPLETED');
    expect(res.body.new_status).toBe('completed');

    order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('completed');
  });

  test('Payment then shipment: shipment arriving last completes the order', async () => {
    await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'payment.created',
        payment: { salesorder_id: testZohoSoId, payment_number: 'PAY-FIRST-01', amount: 1500.0, date: '2026-09-01' }
      });
    let order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    // Paid, but the pipeline hasn't moved — payment is on terms and only
    // decides completion.
    expect(order.status).toBe('ready_for_draft_invoice');

    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'shipment.created',
        shipment: { salesorder_id: testZohoSoId, tracking_number: 'LBC-55010', carrier: 'LBC Express' }
      });
    expect(res.body.action).toBe('DISPATCHED_ORDER_COMPLETED');
    expect(res.body.new_status).toBe('completed');

    order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('completed');
  });

  test('A completed order is not reopened by a later invoice webhook', async () => {
    await db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(testOrderId);
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'invoice.created',
        invoice: { salesorder_id: testZohoSoId, invoice_id: 'INV-Z-999', invoice_number: 'INV-000999' }
      });
    expect(res.status).toBe(200);
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('completed');
  });

  test('Processes salesorder.cancelled: cancels local order', async () => {
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'salesorder.cancelled',
        salesorder: { salesorder_id: testZohoSoId, status: 'cancelled' }
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('SO_CANCELLED');
    expect(res.body.new_status).toBe('cancelled');
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('cancelled');
  });

  test('Processes salesorder.deleted: order reads Deleted, not Cancelled', async () => {
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'salesorder.deleted', salesorder: { salesorder_id: testZohoSoId } });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('SO_DELETED');
    expect(res.body.new_status).toBe('deleted');

    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('deleted');

    // The point of the separate status: a removed Sales Order no longer looks
    // identical to a voided one on the order itself, not just in the trail.
    const event = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_DELETED'")
      .get(testOrderId);
    expect(event).toBeDefined();
    expect(event.notes).toMatch(/no longer exists/i);
    expect(
      (await db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_CANCELLED'").get(testOrderId)).n
    ).toBe(0);
  });

  test('A deleted SO on an already-completed order is logged but does not un-finish it', async () => {
    await db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(testOrderId);

    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'salesorder.deleted', salesorder: { salesorder_id: testZohoSoId } });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('SO_DELETED_LOGGED_ONLY');

    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('completed');

    // Before Sep 1 2026 this case logged nothing at all — the whole branch
    // was skipped — so a Sales Order deleted after an order shipped left no
    // trace anywhere.
    const event = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_DELETED'")
      .get(testOrderId);
    expect(event).toBeDefined();
    expect(event.notes).toMatch(/already finished/i);
  });

  test('a refused status write says so in the audit trail instead of looking applied', async () => {
    // Reproduces what happened to TestGM-20260901-0002 on the previous build:
    // the deletion event was written, the status write was refused by the
    // state machine, and the trail showed "Sales Order no longer exists in
    // Zoho" against an unchanged status with no hint that anything failed.
    //
    // 'completed' is terminal, so a *cancellation* (not a deletion — that
    // path has its own already-finished handling) is refused from there.
    await db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(testOrderId);

    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'salesorder.cancelled', salesorder: { salesorder_id: testZohoSoId, status: 'void' } });
    expect(res.status).toBe(200);

    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('completed');

    const event = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_CANCELLED' ORDER BY id DESC")
      .get(testOrderId);
    expect(event).toBeDefined();
    // Whatever the reason, the entry must explain why the status is unchanged
    // rather than reading as a successful update.
    expect(event.notes).toMatch(/status kept as|could NOT be moved/i);
    expect(event.old_status).toBe(event.new_status);
  });

  test('salesorder.cancelled still lands on Cancelled, not Deleted', async () => {
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'salesorder.cancelled', salesorder: { salesorder_id: testZohoSoId, status: 'void' } });
    expect(res.body.action).toBe('SO_CANCELLED');
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId)).status).toBe('cancelled');
  });

  test('Handles JSONString formatted payload from Zoho Custom Webhook', async () => {
    const jsonPayload = JSON.stringify({
      event: 'payment.success',
      payment: { reference_number: testOrderNumber, payment_id: 'ZPAY-10029', amount: 1500.00 }
    });
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({ JSONString: jsonPayload });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('PAYMENT_VERIFIED');
  });
});
