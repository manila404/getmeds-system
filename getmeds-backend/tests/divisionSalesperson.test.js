/**
 * B&B / URO / STC: the Salesperson follows the Headquarter ("STC | KALAW") and
 * may be any name Zoho recognises, not only the acting account's own. Other
 * Divisions keep the own-list rule. Oct 2, 2026.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const salespersonService = require('../src/services/salespersonService');

const PREFIX = 'div-sp-test-';
const orderIds = [];
let token, repId, customerId, productId, verifySpy, zohoSpy;

beforeAll(async () => {
  process.env.ZOHO_TEST_CUSTOMER_IDS = '';
  process.env.ZOHO_TEST_CUSTOMER_ID = '';
  const email = `${PREFIX}${Date.now()}@getmeds.ph`;
  await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, first_name, last_name, display_name, division, salesperson)
       VALUES ('Khalygen Test', ?, ?, 'medrep', 'Khalygen', 'Test', 'Khalygen Test', 'STC', 'STC | GIENEL')`
    )
    .run(email, bcrypt.hashSync('long-enough-pw', 4));
  repId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
  const login = await request(app).post('/api/auth/login').send({ email, password: 'long-enough-pw' });
  token = login.body.data.token;
  customerId = (await db.prepare("INSERT INTO customers (name, type, zoho_contact_id) VALUES (?, 'credit', ?)").run(`${PREFIX}client`, `${PREFIX}zc`)).lastInsertRowid;
  productId = (await db.prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, 10)').run(`${PREFIX}product`, `${PREFIX}sku`)).lastInsertRowid;
  verifySpy = jest.spyOn(salespersonService, 'verify').mockImplementation(async (name) =>
    ['STC | KALAW'].includes(name) ? { checked: true, exists: true, matchedName: name } : { checked: true, exists: false });
  zohoSpy = jest.spyOn(zoho, 'createSalesOrder').mockResolvedValue({ code: 0, salesorder: { salesorder_id: 'X', salesorder_number: 'SO-X' } });
});

afterAll(async () => {
  verifySpy.mockRestore(); zohoSpy.mockRestore();
  for (const id of orderIds) {
    for (const t of ['notifications', 'order_events', 'payments', 'dispatch_records', 'order_items']) await db.prepare(`DELETE FROM ${t} WHERE ${t === 'order_items' || t === 'order_events' || t === 'payments' || t === 'dispatch_records' || t === 'notifications' ? 'order_id' : 'id'} = ?`).run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM products WHERE id = ?').run(productId);
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(repId);
});

const create = (body) =>
  request(app).post('/api/orders').set('Authorization', `Bearer ${token}`).send({
    customer_id: customerId, items: [{ product_id: productId, quantity: 1 }], delivery_address: '1 Test St', ...body
  });

test('STC order accepts a Zoho-recognised Salesperson that is not the account\'s own', async () => {
  const res = await create({ division: 'STC', sub_division: 'MD Telesales', headquarter: 'KALAW', salesperson: 'STC | KALAW', pap_program: 'DSWD' });
  expect(res.status).toBeLessThan(300);
  const id = res.body.data.order.id; orderIds.push(id);
  const row = await db.prepare('SELECT division, sub_division, headquarter, salesperson FROM orders WHERE id = ?').get(id);
  expect(row.division).toBe('STC');
  expect(row.sub_division).toBe('MD Telesales');
  expect(row.headquarter).toBe('KALAW');
  const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'PAP_PROGRAM_SET'").get(id);
  expect(ev.notes).toMatch(/DSWD/);
});

test('STC order with a name Zoho does not know is refused', async () => {
  const res = await create({ division: 'STC', salesperson: 'STC | NOWHERE' });
  expect(res.status).toBe(400);
});

test('another Division still only accepts the account\'s own Salesperson', async () => {
  const res = await create({ division: 'HOS', salesperson: 'STC | KALAW' });
  expect(res.status).toBe(400);
});
