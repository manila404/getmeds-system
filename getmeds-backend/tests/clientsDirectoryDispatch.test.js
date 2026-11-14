/**
 * Nov 14, 2026 (Aaron): the Clients Directory for Dispatch, because Pharmacy backtracks clients'
 * orders, especially the ones with a prescription. Read-only list (same narrowed fields as MedReps),
 * a "with prescription" filter, and one client's order history with each order's prescription state.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
let dispatchToken, medrepToken, customerId, otherId;
const orderIds = [];
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'demo123' })).body.data.token;
const as = (t) => ({ Authorization: `Bearer ${t}` });

async function order(cid, key, rx = null) {
  const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  const ref = `GM-CLRX-${stamp}-${key}`;
  await db.prepare("INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address) VALUES (?, ?, ?, 'ready_for_dispatch', 'direct', 500, 'x')").run(ref, cid, m);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  orderIds.push(id);
  if (rx) {
    await db.prepare(`INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, file_size, uploaded_by, uploaded_at)
                      VALUES (?, 'prescription', ?, ?, 'rx.jpg', 'image/jpeg', 100, ?, ?)`).run(id, rx, `orders/${id}/prescription/${ref}.jpg`, m, new Date().toISOString());
  }
  return id;
}

beforeAll(async () => {
  dispatchToken = await login('dispatch@getmeds.ph');
  medrepToken = await login('medrep@getmeds.ph');
  for (const [name, cat] of [[`RX PATIENT ${stamp}`, 'patient'], [`NO RX CLINIC ${stamp}`, 'hospital']]) {
    await db.prepare("INSERT INTO customers (name, type, category, tin, is_active) VALUES (?, 'direct', ?, '123-456', 1)").run(name, cat);
  }
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`RX PATIENT ${stamp}`)).id;
  otherId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`NO RX CLINIC ${stamp}`)).id;
  await order(customerId, 'a', 'verified');
  await order(customerId, 'b');
  await order(otherId, 'c');
});

afterAll(async () => {
  for (const id of orderIds) {
    await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM customers WHERE id IN (?, ?)').run(customerId, otherId);
});

test('Dispatch can read the directory, without TIN or Zoho fields', async () => {
  const res = await request(app).get('/api/customers').query({ search: `RX PATIENT ${stamp}` }).set(as(dispatchToken));
  expect(res.status).toBe(200);
  const row = res.body.data.customers.find((c) => c.id === customerId);
  expect(row).toBeTruthy();
  expect(row.tin).toBeUndefined();
  expect(row.zoho_contact_id).toBeUndefined();
});

test('"With prescription" keeps only clients with a prescription on an order', async () => {
  const res = await request(app).get('/api/customers').query({ rx: 1, search: stamp, limit: 50 }).set(as(dispatchToken));
  const ids = res.body.data.customers.map((c) => c.id);
  expect(ids).toContain(customerId);
  expect(ids).not.toContain(otherId);
});

test("a client's order history shows each order's prescription state", async () => {
  const res = await request(app).get(`/api/customers/${customerId}/orders`).set(as(dispatchToken));
  expect(res.status).toBe(200);
  const byRef = Object.fromEntries(res.body.data.orders.map((o) => [o.getmeds_order_id, o]));
  expect(byRef[`GM-CLRX-${stamp}-a`].rx_state).toBe('verified');
  expect(byRef[`GM-CLRX-${stamp}-a`].rx_files).toBe(1);
  expect(byRef[`GM-CLRX-${stamp}-b`].rx_state).toBe('none');
});

test("a MedRep cannot open a client's full order history (other reps' orders)", async () => {
  const res = await request(app).get(`/api/customers/${customerId}/orders`).set(as(medrepToken));
  expect(res.status).toBe(403);
});

// Nov 14, 2026: "Medicines bought" — what the client bought, added up per medicine, with the part
// that was on orders carrying a prescription, so Pharmacy can check it against the prescription.
test('the history adds up each medicine bought, and how much was on prescription orders', async () => {
  const p = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;
  const [a, b] = orderIds;
  await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 30, 10, 300, 300)').run(a, p);
  await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 60, 10, 600, 600)').run(b, p);
  const res = await request(app).get(`/api/customers/${customerId}/orders`).set(as(dispatchToken));
  const med = res.body.data.medicines.find((m) => m.product_id === p);
  expect(med.total_qty).toBe(90);
  expect(med.rx_qty).toBe(30);
  expect(med.orders).toBe(2);
  const withRx = res.body.data.orders.find((o) => o.rx_state === 'verified');
  expect(withRx.prescriptions).toHaveLength(1);
  expect(withRx.prescriptions[0].view_url).toMatch(/\/api\/attachment-view\?token=/);
  for (const id of [a, b]) await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
});
