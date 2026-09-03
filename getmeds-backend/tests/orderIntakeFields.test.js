/**
 * Aug 27, 2026: order-intake fields (Courier, Doctor, Hospital, Patient,
 * MOP, Receiver, Contact No., Source, "Pls Give" notes) — added so the
 * MedRep order form can capture the same fields the team's old
 * paper/spreadsheet intake sheet did, alongside (not instead of) the
 * existing structured product cart + automatic Zoho Sales Order creation.
 * These are purely informational: optional on create, never sent to Zoho.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

describe('Orders — optional intake fields', () => {
  let medrepToken;
  let customerId;
  let productId;
  const cleanupOrderIds = [];

  beforeAll(async () => {
    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;

    customerId = (await db.prepare(`SELECT id FROM customers WHERE is_active = 1 LIMIT 1`).get()).id;
    productId = (await db.prepare(`SELECT id FROM products WHERE is_active = 1 LIMIT 1`).get()).id;
  });

  afterAll(async () => {
    for (const id of cleanupOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('POST /api/orders persists the optional intake fields when provided', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: 'Test Hospital, Room 101',
        courier: 'LBC',
        doctor_name: 'Dr. Santos',
        hospital_name: 'Test Hospital',
        patient_name: 'Juan Dela Cruz',
        mode_of_payment: 'GCash',
        receiver_name: 'Maria Cruz',
        receiver_contact_no: '09171234567',
        order_source: 'Referral',
        pls_give_note: 'Give branded, not generic'
      });

    expect(res.status).toBe(201);
    cleanupOrderIds.push(res.body.data.order.id);

    const stored = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(stored.intake_courier).toBe('LBC');
    expect(stored.intake_doctor).toBe('Dr. Santos');
    expect(stored.intake_hospital).toBe('Test Hospital');
    expect(stored.intake_patient).toBe('Juan Dela Cruz');
    expect(stored.intake_mop).toBe('GCash');
    expect(stored.intake_receiver).toBe('Maria Cruz');
    expect(stored.intake_contact_no).toBe('09171234567');
    expect(stored.intake_source).toBe('Referral');
    expect(stored.intake_pls_give).toBe('Give branded, not generic');

    // None of this ever reaches the Zoho payload — spot-check the response
    // still returns a normal order (no Zoho-shaped fields mixed in).
    expect(res.body.data.order.getmeds_order_id).toMatch(/^(GM|TestGM|DryGM)-/);
  });

  test('POST /api/orders still works with all intake fields omitted (fully optional, all NULL)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: 'Another Address'
      });

    expect(res.status).toBe(201);
    cleanupOrderIds.push(res.body.data.order.id);

    const stored = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(stored.intake_courier).toBeNull();
    expect(stored.intake_doctor).toBeNull();
    expect(stored.intake_mop).toBeNull();
  });

  test('blank-string intake fields are stored as NULL, not empty strings', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({
        customer_id: customerId,
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: 'Blank Fields Test',
        courier: '   ',
        doctor_name: ''
      });

    expect(res.status).toBe(201);
    cleanupOrderIds.push(res.body.data.order.id);

    const stored = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(stored.intake_courier).toBeNull();
    expect(stored.intake_doctor).toBeNull();
  });
});
