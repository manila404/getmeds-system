/**
 * Oct 9, 2026 — Management's stock check and warehouse choice before approving an order.
 *
 * Uses the mock Zoho adapter's deterministic stock (MockZohoAdapter.getItemWarehouses):
 *   MOCK-ITEM-P1: 1,000 in the main warehouse (40 committed), 50 in Cebu
 *   MOCK-ITEM-P2: 3 in the main warehouse, 500 in Cebu (20 committed), 200 in Davao
 * An order for 10 of P2 is therefore short in the main warehouse and fine in Cebu.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const stockCheckService = require('../src/services/stockCheckService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const created = { orders: [], products: [] };
let managerToken, medrepToken, medrepId, customerId, p1, p2;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function product(sku, zohoItemId) {
  await db.prepare('INSERT INTO products (name, sku, unit_price, is_active, zoho_item_id) VALUES (?, ?, 100, 1, ?)').run(`Stock ${sku}`, sku, zohoItemId);
  const id = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(sku)).id;
  created.products.push(id);
  return id;
}

async function pendingOrder(lines) {
  const ref = `GM-STK-${stamp}-${created.orders.length}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
       VALUES (?, ?, ?, 'pending_management_approval', 'credit', 1000, '1 Stock St')`
    )
    .run(ref, customerId, medrepId);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  created.orders.push(id);
  for (const [pid, qty] of lines) {
    await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, ?, 100, ?, ?)').run(id, pid, qty, qty * 100, qty * 100);
  }
  return id;
}
const check = (id, w, token = managerToken) =>
  request(app).get(`/api/orders/${id}/stock-check${w ? `?warehouse_id=${w}` : ''}`).set(auth(token));
const approve = (id, body, token = managerToken) => request(app).post(`/api/orders/${id}/approve`).set(auth(token)).send(body);
const row = (id) => db.prepare('SELECT status, fulfil_warehouse_id, fulfil_warehouse_name FROM orders WHERE id = ?').get(id);

beforeAll(async () => {
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  p1 = await product(`STK-P1-${stamp}`, 'MOCK-ITEM-P1');
  p2 = await product(`STK-P2-${stamp}`, 'MOCK-ITEM-P2');
});

beforeEach(() => stockCheckService._clearCache());

afterAll(async () => {
  for (const id of created.orders) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  for (const id of created.products) await db.prepare('DELETE FROM products WHERE id = ?').run(id);
});

describe('the stock check', () => {
  test('measures every line against the main warehouse by default, and says which warehouses could fill the order', async () => {
    const id = await pendingOrder([[p2, 10], [p1, 5]]);
    const res = await check(id);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.available).toBe(true);
    expect(d.selected_warehouse_name).toBe('Getmeds Philippines Inc.');
    expect(d.summary.short_lines).toBe(1);
    const p2line = d.lines.find((l) => l.name.includes('P2'));
    expect(p2line.status).toBe('short');
    expect(p2line.short_by).toBe(7);
    expect(d.warehouses.find((w) => w.name === 'CEBU WAREHOUSE').fills_all).toBe(true);
    expect(d.warehouses.find((w) => w.name === 'Getmeds Philippines Inc.').fills_all).toBe(false);
  });

  test('choosing Cebu makes the same order fine, and an inactive warehouse is never offered', async () => {
    const id = await pendingOrder([[p2, 10], [p1, 5]]);
    const d = (await check(id, 'W-CEBU')).body.data;
    expect(d.selected_warehouse_name).toBe('CEBU WAREHOUSE');
    expect(d.summary.all_ok).toBe(true);
    expect(d.warehouses.map((w) => w.name)).not.toContain('HOMESTOCKS- NASHRINA');
  });

  test('the same item on two lines counts as one demand', async () => {
    const id = await pendingOrder([[p2, 2], [p2, 2]]);
    const d = (await check(id)).body.data; // 4 needed, main has 3
    expect(d.lines.every((l) => l.status === 'short')).toBe(true);
  });

  test('only Management and Admin can ask', async () => {
    const id = await pendingOrder([[p1, 1]]);
    expect((await check(id, null, medrepToken)).status).toBe(403);
  });

  test('if Zoho cannot be reached the answer says so, and nothing breaks', async () => {
    const zoho = require('../src/integrations/zoho');
    const id = await pendingOrder([[p1, 1]]);
    zoho.setSimulatedOutage(true);
    try {
      const res = await check(id);
      expect(res.status).toBe(200);
      expect(res.body.data.available).toBe(false);
    } finally {
      zoho.setSimulatedOutage(false);
    }
  });
});

describe('approving with a warehouse', () => {
  test('a warehouse that cannot fill the order is refused until Management acknowledges it', async () => {
    const id = await pendingOrder([[p2, 10]]);
    const res = await approve(id, { warehouse_id: 'W-MAIN' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_SHORT');
    expect((await row(id)).status).toBe('pending_management_approval');

    const ok = await approve(id, { warehouse_id: 'W-MAIN', stock_ack: true });
    expect(ok.status).toBe(200);
    expect((await row(id)).fulfil_warehouse_name).toBe('Getmeds Philippines Inc.');
  });

  test('a warehouse that can fill it is saved on the order and goes to Zoho on every line', async () => {
    const zoho = require('../src/integrations/zoho');
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const id = await pendingOrder([[p2, 10], [p1, 5]]);
    const res = await approve(id, { warehouse_id: 'W-CEBU' });
    expect(res.status).toBe(200);
    const saved = await row(id);
    expect(saved.fulfil_warehouse_id).toBe('W-CEBU');
    expect(saved.fulfil_warehouse_name).toBe('CEBU WAREHOUSE');
    expect(spy.mock.calls[0][0].warehouse_id).toBe('W-CEBU');
    spy.mockRestore();
    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'MANAGEMENT_APPROVED'").get(id);
    expect(ev.notes).toMatch(/CEBU WAREHOUSE/);
  });

  test('an unknown warehouse is refused and nothing changes', async () => {
    const id = await pendingOrder([[p1, 1]]);
    const res = await approve(id, { warehouse_id: 'W-NOPE' });
    expect(res.status).toBe(400);
    expect((await row(id)).status).toBe('pending_management_approval');
  });

  test('with no warehouse chosen it is the approval it always was: nothing saved, nothing sent', async () => {
    const zoho = require('../src/integrations/zoho');
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    const id = await pendingOrder([[p2, 10]]);
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect((await row(id)).fulfil_warehouse_id).toBeNull();
    expect(spy.mock.calls[0][0].warehouse_id).toBeNull();
    spy.mockRestore();
  });

  test('if Zoho is down while a warehouse is chosen, approval waits instead of guessing', async () => {
    const zoho = require('../src/integrations/zoho');
    const id = await pendingOrder([[p1, 1]]);
    zoho.setSimulatedOutage(true);
    try {
      const res = await approve(id, { warehouse_id: 'W-MAIN' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('STOCK_CHECK_UNAVAILABLE');
      expect((await row(id)).status).toBe('pending_management_approval');
    } finally {
      zoho.setSimulatedOutage(false);
    }
  });
});
