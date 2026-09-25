/**
 * Sep 25, 2026 — GET /api/orders?search= : the search box on the Orders table
 * (Dispatch's "My Catered Orders", the MedRep's "My Orders", Management's log).
 *
 * Matches the order id, the customer, the Zoho SO number, and the RECEIVER
 * (name or contact number). A search can only ever narrow: it must not widen
 * what a MedRep is allowed to see.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = [];
let dispatchToken, medrepToken, medrepId, otherRepId, customerId, customerName;
const stamp = Date.now();

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeOrder({ ref, receiver = null, contact = null, so = null, medrep = medrepId }) {
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, intake_receiver, intake_contact_no, zoho_so_number)
       VALUES (?, ?, ?, 'ready_for_dispatch', 'credit', 500, '1 Search St', ?, ?, ?)`
    )
    .run(ref, customerId, medrep, receiver, contact, so);
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  return row.id;
}

const search = async (q, token = dispatchToken, extra = '') =>
  (await request(app).get(`/api/orders?search=${encodeURIComponent(q)}&limit=100${extra}`).set(auth(token))).body;

describe('GET /api/orders?search=', () => {
  let byReceiver, byContact, bySo, plain, othersOrder;

  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    otherRepId = (await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()).id;
    const c = await db.prepare('SELECT id, name FROM customers LIMIT 1').get();
    customerId = c.id;
    customerName = c.name;

    byReceiver = await makeOrder({ ref: `GM-SRCH-A-${stamp}`, receiver: `Zelda Quixote ${stamp}`, contact: '0917 111 2222' });
    byContact = await makeOrder({ ref: `GM-SRCH-B-${stamp}`, receiver: 'Someone Else', contact: `0999-${stamp}` });
    bySo = await makeOrder({ ref: `GM-SRCH-C-${stamp}`, so: `SO-ZZ-${stamp}` });
    plain = await makeOrder({ ref: `GM-SRCH-D-${stamp}` });
    othersOrder = await makeOrder({ ref: `GM-SRCH-E-${stamp}`, receiver: `Zelda Quixote ${stamp}`, medrep: otherRepId });
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  const ids = (body) => body.data.orders.map((o) => o.id);

  test('finds an order by its receiver, case-insensitively, on part of the name', async () => {
    const res = await search(`zelda quix`);
    expect(res.success).toBe(true);
    expect(ids(res)).toEqual(expect.arrayContaining([byReceiver]));
    expect(ids(res)).not.toContain(plain);
    // The row carries the receiver, for the table's column.
    const row = res.data.orders.find((o) => o.id === byReceiver);
    expect(row.intake_receiver).toBe(`Zelda Quixote ${stamp}`);
  });

  test('finds by the receiver\'s contact number', async () => {
    expect(ids(await search(`0999-${stamp}`))).toEqual([byContact]);
  });

  test('finds by order id and by Zoho SO number', async () => {
    expect(ids(await search(`GM-SRCH-D-${stamp}`))).toEqual([plain]);
    expect(ids(await search(`so-zz-${stamp}`))).toEqual([bySo]);
  });

  test('finds by customer name', async () => {
    const res = await search(customerName);
    expect(ids(res)).toEqual(expect.arrayContaining([byReceiver, plain]));
  });

  test('the total matches the rows, and an empty search changes nothing', async () => {
    const res = await search(`zelda quix`);
    expect(res.data.pagination.total).toBe(res.data.orders.length);
    const all = await search('');
    expect(all.data.orders.length).toBeGreaterThan(res.data.orders.length);
  });

  test('%, _ and \\ are matched literally, not as wildcards', async () => {
    expect(ids(await search('%'))).toEqual([]);
    expect(ids(await search('GM-SRCH-_-' + stamp))).toEqual([]);
    expect(ids(await search('\\'))).toEqual([]);
  });

  test('a MedRep\'s search can only narrow their own orders', async () => {
    const res = await search(`zelda quix`, medrepToken);
    expect(ids(res)).toContain(byReceiver);
    expect(ids(res)).not.toContain(othersOrder);
  });

  test('combines with the other filters', async () => {
    const res = await search(`zelda quix`, dispatchToken, '&status=completed');
    expect(ids(res)).toEqual([]);
  });
});
