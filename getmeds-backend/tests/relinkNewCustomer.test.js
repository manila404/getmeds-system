/**
 * "This is a new customer": create it in Zoho as a customer and point the
 * customer record at it. Oct 5, 2026 (order GM-20261005-0043, a hospital Zoho
 * had only as a vendor).
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const orderIds = [];
const customerIds = [];
let managerToken, medrepToken, medrepId, getSpy, createSpy;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function customer(zid, contact = '0917 000 0000') {
  const name = `NEWCUST HOSPITAL ${stamp}-${customerIds.length}`;
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, source, is_active, contact_number) VALUES (?, 'credit', ?, 'zoho', 1, ?)").run(name, zid, contact);
  const id = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(name)).id;
  customerIds.push(id);
  return id;
}
async function order(customerId, { soId = null } = {}) {
  const ref = `GM-NC-${stamp}-${orderIds.length}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, submitted_at, zoho_so_id, zoho_sync_status)
     VALUES (?, ?, ?, 'pending_management_approval', 'credit', 500, '1 Test St', ?, ?, 'failed')`
  ).run(ref, customerId, medrepId, new Date().toISOString(), soId);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  orderIds.push(id);
  return id;
}
const call = (id, body = {}, token = managerToken) => request(app).post(`/api/orders/${id}/relink-customer/new`).set(auth(token)).send(body);
const zid = async (cid) => (await db.prepare('SELECT zoho_contact_id FROM customers WHERE id = ?').get(cid)).zoho_contact_id;

beforeAll(async () => {
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
});
beforeEach(() => {
  getSpy = jest.spyOn(zoho, 'getContact').mockImplementation(async (id) =>
    ({ code: 0, contact: { contact_id: id, contact_type: String(id).startsWith('VEND') ? 'vendor' : 'customer', status: 'active' } }));
  createSpy = jest.spyOn(zoho, 'createContact').mockResolvedValue({ code: 0, contact: { contact_id: `NEWZ-${stamp}-${Math.random().toString(36).slice(2, 7)}` } });
});
afterEach(() => { getSpy.mockRestore(); createSpy.mockRestore(); });
afterAll(async () => {
  for (const id of orderIds) { await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id); await db.prepare('DELETE FROM orders WHERE id = ?').run(id); }
  for (const id of customerIds) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
});

test('creates the customer in Zoho as a customer and points the record at it; logged on the order', async () => {
  const c = await customer(`VEND-${stamp}-1`);
  const o = await order(c);
  const res = await call(o, { note: 'New hospital customer' });
  expect(res.status).toBe(200);
  const sent = createSpy.mock.calls[0][0];
  expect(sent.display_name).toMatch(/NEWCUST HOSPITAL/);
  expect(sent.contact_number).toBe('0917 000 0000');
  expect(await zid(c)).toBe(res.body.data.customer.zoho_contact_id);
  const ev = await db.prepare("SELECT notes, metadata FROM order_events WHERE order_id = ? AND event_type = 'ORDER_CUSTOMER_RELINKED'").get(o);
  expect(ev.notes).toMatch(/NEW customer/);
  expect(JSON.parse(ev.metadata).created_new).toBe(true);
});

test('refused when Zoho already has it as a customer (no duplicate created)', async () => {
  const c = await customer(`CUST-${stamp}-2`);
  const o = await order(c);
  const res = await call(o);
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('ALREADY_A_CUSTOMER');
  expect(createSpy).not.toHaveBeenCalled();
});

test('refused once the order has a Zoho Sales Order', async () => {
  const c = await customer(`VEND-${stamp}-3`);
  const o = await order(c, { soId: `SO-${stamp}` });
  expect((await call(o)).status).toBe(409);
  expect(await zid(c)).toBe(`VEND-${stamp}-3`);
});

test('nothing changes when Zoho refuses to create it, or cannot be reached', async () => {
  const c = await customer(`VEND-${stamp}-4`);
  const o = await order(c);
  createSpy.mockRejectedValue(new Error('duplicate'));
  expect((await call(o)).status).toBe(502);
  getSpy.mockRejectedValue(new Error('ETIMEDOUT'));
  expect((await call(o)).status).toBe(502);
  expect(await zid(c)).toBe(`VEND-${stamp}-4`);
});

test('needs a contact number when the customer has none', async () => {
  const c = await customer(`VEND-${stamp}-5`, null);
  const o = await order(c);
  expect((await call(o)).status).toBe(400);
  expect((await call(o, { contact_number: '0918 111 2222' })).status).toBe(200);
});

test('a MedRep cannot do it', async () => {
  const c = await customer(`VEND-${stamp}-6`);
  const o = await order(c);
  expect((await call(o, {}, medrepToken)).status).toBe(403);
});
