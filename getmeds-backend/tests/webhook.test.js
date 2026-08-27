const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

describe('Zoho Webhook Receiver — POST /api/webhooks/zoho', () => {
  let testOrderId;
  const testOrderNumber = 'GM-WH-TEST-0001';
  const testZohoSoId = 'ZOHO-SO-WH-12345';
  let medrepUser;
  let customer;

  beforeAll(() => {
    medrepUser = db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    customer = db.prepare("SELECT id FROM customers WHERE type = 'direct' LIMIT 1").get();
  });

  beforeEach(() => {
    const existing = db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(testOrderNumber);
    if (existing) {
      db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      db.prepare('DELETE FROM payments WHERE order_id = ?').run(existing.id);
      db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(existing.id);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(existing.id);
      db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    const result = db.prepare(`
      INSERT INTO orders (
        getmeds_order_id, customer_id, medrep_id, status, customer_type,
        total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status
      ) VALUES (?, ?, ?, 'waiting_for_payment', 'direct', 1500.00, '123 Test Street, Manila', ?, 'SO-99999', 'synced')
    `).run(testOrderNumber, customer.id, medrepUser.id, testZohoSoId);
    testOrderId = result.lastInsertRowid;
  });

  afterAll(() => {
    if (testOrderId) {
      db.prepare('DELETE FROM order_events WHERE order_id = ?').run(testOrderId);
      db.prepare('DELETE FROM payments WHERE order_id = ?').run(testOrderId);
      db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(testOrderId);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(testOrderId);
      db.prepare('DELETE FROM orders WHERE id = ?').run(testOrderId);
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

  test('Processes payment.created / invoice.paid: updates payment and advances order', async () => {
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
    expect(res.body.new_status).toBe('ready_for_dispatch');
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('ready_for_dispatch');
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(testOrderId);
    expect(payment).toBeDefined();
    expect(payment.status).toBe('verified');
    expect(payment.payment_reference).toBe('PAY-ZOHO-9988');
  });

  test('Processes shipment.created: updates dispatch_records and advances order', async () => {
    db.prepare("UPDATE orders SET status = 'ready_for_dispatch' WHERE id = ?").run(testOrderId);
    const res = await request(app)
      .post('/api/webhooks/zoho')
      .send({
        event_type: 'shipment.created',
        shipment: { salesorder_id: testZohoSoId, tracking_number: 'LBC-PH-99228811', carrier: 'LBC Express' }
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('DISPATCH_UPDATED');
    expect(res.body.new_status).toBe('dispatched');
    const dispatch = db.prepare('SELECT * FROM dispatch_records WHERE order_id = ?').get(testOrderId);
    expect(dispatch.tracking_number).toBe('LBC-PH-99228811');
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
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(testOrderId);
    expect(order.status).toBe('cancelled');
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
