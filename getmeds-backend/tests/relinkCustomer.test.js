/**
 * Management corrects an order linked to a customer Zoho keeps as a VENDOR.
 * Oct 2, 2026 (order GM-20261001-0044).
 *
 * Zoho refuses a Sales Order for a contact that is not typed "customer". The
 * sync copies vendors in as customers, so an order could be linked to one and
 * stall at a failed sync. POST /api/orders/:id/relink-customer points the order
 * at the right customer record. These tests keep that fix honest: it checks the
 * new customer against Zoho first, refuses anything that would fail the same
 * way, changes nothing when it refuses, and leaves a record of who did it.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const orderIds = [];
const customerIds = [];
let managerToken, medrepToken, medrepId, vendorCopyId, customerCopyId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function newCustomer(name, zohoContactId) {
  await db
    .prepare("INSERT INTO customers (name, type, zoho_contact_id, source, is_active) VALUES (?, 'credit', ?, 'zoho', 1)")
    .run(name, zohoContactId);
  const row = await db.prepare('SELECT id FROM customers WHERE name = ?').get(name);
  customerIds.push(row.id);
  return row.id;
}

async function failedOrder({ soId = null } = {}) {
  const ref = `GM-RELINK-${stamp}-${orderIds.length}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, submitted_at, zoho_so_id, zoho_so_number, zoho_sync_status)
       VALUES (?, ?, ?, 'pending_management_approval', 'credit', 500, '1 Test St', ?, ?, ?, ?)`
    )
    .run(ref, vendorCopyId, medrepId, new Date().toISOString(), soId, soId ? 'SO-EXISTING' : null, soId ? 'synced' : 'failed');
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  orderIds.push(row.id);
  return row.id;
}

const relink = (orderId, body, token = managerToken) =>
  request(app).post(`/api/orders/${orderId}/relink-customer`).set(auth(token)).send(body);
const customerOf = async (orderId) => (await db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId)).customer_id;

describe('POST /api/orders/:id/relink-customer', () => {
  let contactSpy;

  beforeAll(async () => {
    managerToken = await loginAs('manager@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    // The "vendor copy" the order is stuck on, and the real customer record.
    vendorCopyId = await newCustomer(`RELINK VENDOR COPY ${stamp}`, `VENDOR-${stamp}`);
    customerCopyId = await newCustomer(`Relink Customer Copy ${stamp}`, `CUSTOMER-${stamp}`);
  });

  beforeEach(() => {
    contactSpy = jest.spyOn(zoho, 'getContact').mockImplementation(async (contactId) => {
      if (String(contactId).startsWith('VENDOR')) return { code: 0, contact: { contact_id: contactId, contact_type: 'vendor', status: 'active' } };
      if (contactId === `CUSTOMER-${stamp}`) return { code: 0, contact: { contact_id: contactId, contact_type: 'customer', status: 'active' } };
      return { code: 4, message: 'The contact ID given seems to be incorrect.' };
    });
  });
  afterEach(() => contactSpy.mockRestore());

  afterAll(async () => {
    for (const id of orderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of customerIds) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  test('moves the order to the customer record, and records who did it', async () => {
    const id = await failedOrder();
    const res = await relink(id, { customer_id: customerCopyId, note: 'Zoho had the old record as a vendor' });

    expect(res.status).toBe(200);
    expect(await customerOf(id)).toBe(customerCopyId);

    const ev = await db.prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ORDER_CUSTOMER_RELINKED'").get(id);
    expect(ev).toBeTruthy();
    expect(ev.notes).toMatch(/Zoho had the old record as a vendor/);
    expect(ev.actor_name).toBeTruthy();
  });

  test('refuses a customer Zoho also keeps as a vendor, and changes nothing', async () => {
    const id = await failedOrder();
    const anotherVendorCopy = await newCustomer(`RELINK OTHER VENDOR COPY ${stamp}`, `VENDOR-2-${stamp}`);
    const res = await relink(id, { customer_id: anotherVendorCopy });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WRONG_CONTACT_TYPE');
    expect(await customerOf(id)).toBe(vendorCopyId);
  });

  test('refuses the customer the order already has', async () => {
    const id = await failedOrder();
    const res = await relink(id, { customer_id: vendorCopyId });
    expect(res.status).toBe(400);
  });

  test('changes nothing when Zoho cannot be reached', async () => {
    contactSpy.mockRejectedValue(new Error('ETIMEDOUT'));
    const id = await failedOrder();
    const res = await relink(id, { customer_id: customerCopyId });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ZOHO_UNREACHABLE');
    expect(await customerOf(id)).toBe(vendorCopyId);
  });

  test('refuses a customer that is not in Zoho yet', async () => {
    const id = await failedOrder();
    const notInZoho = await newCustomer(`Relink Local Only ${stamp}`, null);
    const res = await relink(id, { customer_id: notInZoho });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_IN_ZOHO');
    expect(await customerOf(id)).toBe(vendorCopyId);
  });

  test('refuses once the order already has a Zoho Sales Order', async () => {
    const id = await failedOrder({ soId: `ZSO-${stamp}` });
    const res = await relink(id, { customer_id: customerCopyId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_ZOHO');
    expect(await customerOf(id)).toBe(vendorCopyId);
  });

  test('needs a customer to be chosen', async () => {
    const id = await failedOrder();
    const res = await relink(id, {});
    expect(res.status).toBe(400);
  });

  test('is for Management and Admin: a MedRep is refused', async () => {
    const id = await failedOrder();
    const res = await relink(id, { customer_id: customerCopyId }, medrepToken);
    expect(res.status).toBe(403);
    expect(await customerOf(id)).toBe(vendorCopyId);
  });
});
