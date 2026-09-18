/**
 * Sep 18, 2026 — the Sales Order's own Zoho PDF Template, picked to match
 * Invoicing From. Until now this was never sent, so every Sales Order fell
 * back to whatever this org's own default template is configured as, no
 * matter which entity was actually invoicing.
 *
 * Ids confirmed live (GET /salesorders/templates, this exact org):
 *   "2MG Template"      -> 2254168001903121678
 *   "Standard Template" -> 2254168000000019003
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const TWO_MG_TEMPLATE_ID = '2254168001903121678';
const STANDARD_TEMPLATE_ID = '2254168000000019003';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('Sales Order PDF Template follows Invoicing From', () => {
  let managerToken, customerId, productId;
  const createdOrderIds = [];

  beforeAll(async () => {
    managerToken = await loginAs('manager@getmeds.ph');
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;

    const ref = `FIXTURE-TEMPLATE-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number,
                                address, is_active, zoho_contact_id, source)
         VALUES (?, 'credit', 100000, 'Contact', '09170000004', '1 Template St, Manila', 1, ?, 'local')`
      )
      .run(`FIXTURE Template Customer ${ref}`, ref);
    customerId = (await db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?').get(ref)).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  });

  // Raised by Management, so it syncs to Zoho on creation (approved on
  // creation — no approval queue in the way of seeing the template picked).
  async function createOrder(invoicingFrom) {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(managerToken))
      .send({
        customer_id: customerId,
        customer_type: 'credit',
        delivery_address: '1 Template St',
        invoicing_from: invoicingFrom,
        items: [{ product_id: productId, quantity: 1, rate: 100 }]
      });
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);
    return res.body.data.order;
  }
  const zohoSalesOrder = async (order) => {
    const zoho = require('../src/integrations/zoho');
    return (await zoho.getSalesOrder(order.zoho_so_id)).salesorder;
  };

  test('2mg Incorporated gets the 2MG Template', async () => {
    const order = await createOrder('2mg Incorporated');
    const so = await zohoSalesOrder(order);
    expect(so.template_id).toBe(TWO_MG_TEMPLATE_ID);
  });

  test('Getmeds Philippines Inc. gets the Standard Template', async () => {
    const order = await createOrder('Getmeds Philippines Inc.');
    const so = await zohoSalesOrder(order);
    expect(so.template_id).toBe(STANDARD_TEMPLATE_ID);
  });

  test('no Invoicing From — no template_id sent, Zoho\'s own default applies', async () => {
    const order = await createOrder(undefined);
    const so = await zohoSalesOrder(order);
    expect(so.template_id).toBeUndefined();
  });
});
