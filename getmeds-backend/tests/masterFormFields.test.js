/**
 * Sep 9, 2026 — the "Master Form" intake fields.
 *
 * Five new fields on POST /api/orders, plus three new attachment types. The
 * shape of what is asserted here follows the shape of what can go wrong:
 *
 *   - The fields have to PERSIST. Adding a column to the INSERT and forgetting
 *     to add the parameter shifts every value after it into the wrong column,
 *     which is a silent data corruption rather than an error.
 *   - The two enums have to be VALIDATED here, not at the CHECK constraint —
 *     a constraint violation surfaces as a 500 with a Postgres message.
 *   - `is_doctor: false` has to survive. It is the one falsy value in the set,
 *     and every naive `clean()`/`||` in this codebase turns it into null,
 *     recording "not answered" for everyone who answered No.
 *   - The endpoint must still accept an order with NONE of them. The form
 *     marks most of them required; that is a client-side guarantee, and making
 *     it a server-side one would reject every other caller of this endpoint.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const createdOrderIds = [];
let medrepToken;
let customer;
let product;

async function createOrder(token, body) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customer_id: customer.id,
      items: [{ product_id: product.id, quantity: 1, rate: 10 }],
      delivery_address: '1 Master Form St, Manila',
      ...body
    });
  if (res.body?.data?.order?.id) createdOrderIds.push(res.body.data.order.id);
  return res;
}

describe('Master Form intake fields', () => {
  beforeAll(async () => {
    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrep.body.data.token;

    customer = await db.prepare('SELECT * FROM customers WHERE zoho_contact_id IS NOT NULL AND is_active = 1 LIMIT 1').get();
    product = await db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT 1').get();
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('persists every new field onto the order', async () => {
    const res = await createOrder(medrepToken, {
      expected_shipment_date: '2026-10-01',
      gl_number: 'GL-2026-00123',
      receiver_type: 'representative',
      is_doctor: true,
      doctor_name: 'Dr. Master Form',
      payment_terms: '30 days',
      delivery_notes: 'Handle with care'
    });

    expect(res.statusCode).toBe(201);
    const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.order.id);

    // Read back column by column rather than trusting the response: a missing
    // parameter in the INSERT shifts values into neighbouring columns, and the
    // response echoes what was SENT, so it would look correct either way.
    expect(saved.intake_expected_shipment_date).toBe('2026-10-01');
    expect(saved.intake_gl_number).toBe('GL-2026-00123');
    expect(saved.intake_receiver_type).toBe('representative');
    expect(saved.intake_is_doctor).toBe(1);
    expect(saved.intake_doctor).toBe('Dr. Master Form');
    // The neighbours, to catch exactly that shifting.
    expect(saved.intake_payment_terms).toBe('30 days');
    expect(saved.delivery_notes).toBe('Handle with care');
  });

  test('records "No" to Is Doctor rather than losing it', async () => {
    // false is the one falsy value in this set. clean(), `|| null` and
    // Boolean('false') each turn it into the wrong thing, so this asserts the
    // difference between "answered No" and "never answered".
    const res = await createOrder(medrepToken, { is_doctor: false });
    expect(res.statusCode).toBe(201);

    const saved = await db.prepare('SELECT intake_is_doctor FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(saved.intake_is_doctor).toBe(0);
    expect(saved.intake_is_doctor).not.toBeNull();
  });

  test('leaves Is Doctor unanswered rather than guessing', async () => {
    const res = await createOrder(medrepToken, {});
    expect(res.statusCode).toBe(201);
    const saved = await db.prepare('SELECT intake_is_doctor FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(saved.intake_is_doctor).toBeNull();
  });

  test('still accepts an order with none of the new fields', async () => {
    // The form requires most of them; this endpoint must not. Every existing
    // test and any older client sends an order without them.
    const res = await createOrder(medrepToken, {});
    expect(res.statusCode).toBe(201);
  });

  describe('validation', () => {
    test('rejects an unknown receiver_type by name, not by constraint violation', async () => {
      const res = await createOrder(medrepToken, { receiver_type: 'courier' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/patient, representative/);
    });

    test('accepts a receiver_type in any casing', async () => {
      const res = await createOrder(medrepToken, { receiver_type: 'Patient' });
      expect(res.statusCode).toBe(201);
      const saved = await db.prepare('SELECT intake_receiver_type FROM orders WHERE id = ?').get(res.body.data.order.id);
      expect(saved.intake_receiver_type).toBe('patient');
    });

    test('rejects a malformed expected_shipment_date', async () => {
      // Zoho refuses the whole Sales Order over a bad date and its error names
      // neither the field nor the value, so this is caught before it is sent.
      const res = await createOrder(medrepToken, { expected_shipment_date: '01/10/2026' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toMatch(/YYYY-MM-DD/);
    });
  });

  describe('attachments', () => {
    test('accepts the three new hospital file types', async () => {
      const order = await createOrder(medrepToken, {});
      const orderId = order.body.data.order.id;

      for (const fileType of ['gl', 'prescription', 'id']) {
        const res = await request(app)
          .post(`/api/orders/${orderId}/attachments/upload-url`)
          .set('Authorization', `Bearer ${medrepToken}`)
          .send({ fileName: `${fileType}.pdf`, contentType: 'application/pdf', fileSize: 1024, file_type: fileType });

        // Asserted on the MESSAGE, not the status. Storage may be
        // unconfigured in the test environment, which also produces a 400 —
        // a different failure, and not what this test is about. What must
        // never come back is the file_type rejection.
        const message = res.body?.error?.message || '';
        expect(message).not.toMatch(/file_type must be one of/);
      }
    });

    test('still rejects a file type nothing knows about', async () => {
      const order = await createOrder(medrepToken, {});
      const res = await request(app)
        .post(`/api/orders/${order.body.data.order.id}/attachments/upload-url`)
        .set('Authorization', `Bearer ${medrepToken}`)
        .send({ fileName: 'x.pdf', contentType: 'application/pdf', fileSize: 1024, file_type: 'passport' });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toMatch(/file_type must be one of/);
    });
  });

  describe('editing a draft', () => {
    test('the new fields can be corrected before the order reaches Zoho', async () => {
      // The send-back flow depends on this: Management returns an order to
      // draft, the MedRep fixes it, resubmits. A GL Number that could be
      // entered but never corrected would make that flow useless for exactly
      // the fields most likely to be wrong.
      const created = await createOrder(medrepToken, {
        is_draft: true,
        gl_number: 'GL-WRONG',
        is_doctor: true
      });
      const orderId = created.body.data.order.id;

      const res = await request(app)
        .patch(`/api/orders/${orderId}/details`)
        .set('Authorization', `Bearer ${medrepToken}`)
        .send({ gl_number: 'GL-RIGHT', is_doctor: false, expected_shipment_date: '2026-11-02' });

      expect(res.statusCode).toBe(200);
      const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      expect(saved.intake_gl_number).toBe('GL-RIGHT');
      expect(saved.intake_is_doctor).toBe(0);
      expect(saved.intake_expected_shipment_date).toBe('2026-11-02');
    });
  });
});
