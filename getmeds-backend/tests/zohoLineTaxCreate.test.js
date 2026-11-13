/**
 * Nov 14, 2026 (Aaron: the tax changes after sync). Two causes:
 *   1. CREATE did not send each line's tax, so Zoho applied the item's default tax: a "No Tax" line
 *      became VAT 12% (GM-20261113-0044: ₱910,000 -> ₱1,019,200), and the line sync copied that back.
 *   2. Edit Items / Edit Details / retries built their payload without the order's "VAT inclusive"
 *      setting, so Zoho added the VAT on top (GM-20261113-0056: ₱7,800 -> ₱8,736).
 * No real Zoho is called: fetch is replaced and the request body is checked.
 */
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { buildZohoSalesOrderPayload } = require('../src/services/zohoPayloadBuilder');

const ENV = {
  ZOHO_MODE: 'live', ZOHO_ORG_ID: 'TEST-ORG', ZOHO_ALLOWED_ORG_IDS: 'TEST-ORG', ZOHO_SHARED_TOKEN: 'off',
  ZOHO_API_BASE_URL: 'https://zoho.test/inventory/v1', ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.test',
  ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'secret', ZOHO_REFRESH_TOKEN: 'refresh'
};
const realFetch = global.fetch;
let sent;
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://accounts.zoho.test')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    sent.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ code: 0, salesorder: { salesorder_id: 'Z1', salesorder_number: 'SO-1' } }), { status: 200 });
  });
});
afterEach(() => { global.fetch = realFetch; });

const items = [
  { name: 'A', quantity: 1, unit_price: 100, tax_percent: 0, zoho_item_id: 'I1' },
  { name: 'B', quantity: 1, unit_price: 100, tax_percent: 12, zoho_item_id: 'I2' }
];

test('creating a Sales Order sends each line\'s own tax (No Tax stays No Tax)', async () => {
  const adapter = zoho._buildAdapterForTest(ENV);
  adapter._resolveSalespersonId = async () => 'SP1';
  await adapter.createSalesOrder({ zoho_customer_id: 'C1', getmeds_order_id: 'GM-T-1', salesperson_name: 'B2C | Test', items, is_inclusive_tax: true });
  const so = sent.find((s) => s.method === 'POST' && s.url.includes('/salesorders?'));
  expect(so.body.line_items.map((l) => l.tax_id)).toEqual(['2254168000001813001', '2254168000000078097']);
  expect(so.body.is_inclusive_tax).toBe(true);
});

describe('an edit or retry keeps the order\'s VAT-inclusive setting', () => {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  let orderId;
  beforeAll(async () => {
    const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    await db.prepare(`INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, is_inclusive_tax)
                      VALUES (?, ?, ?, 'ready_for_dispatch', 'credit', 7800, 'x', 1)`).run(`GM-TAX-${stamp}`, c, m);
    orderId = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(`GM-TAX-${stamp}`)).id;
  });
  afterAll(async () => { await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId); });

  test('the rebuilt payload carries it, and the Zoho update sends it', async () => {
    const payload = await buildZohoSalesOrderPayload(orderId);
    expect(payload.is_inclusive_tax).toBe(true);
    const adapter = zoho._buildAdapterForTest(ENV);
    adapter._resolveSalespersonId = async () => 'SP1';
    await adapter.updateSalesOrder('Z1', { ...payload, zoho_customer_id: 'C1', salesperson_name: 'B2C | Test', items });
    const put = sent.find((s) => s.method === 'PUT' && s.url.includes('/salesorders/Z1'));
    expect(put.body.is_inclusive_tax).toBe(true);
    expect(put.body.line_items.map((l) => l.tax_id)).toEqual(['2254168000001813001', '2254168000000078097']);
  });

  test('an exclusive order stays exclusive', async () => {
    await db.prepare('UPDATE orders SET is_inclusive_tax = 0 WHERE id = ?').run(orderId);
    expect((await buildZohoSalesOrderPayload(orderId)).is_inclusive_tax).toBe(false);
  });
});

// Nov 14, 2026 (Aaron): Management can change Tax Inclusive / Exclusive on an order already in
// Zoho, and Zoho gets exactly that; only an order Zoho has invoiced is refused.
describe('Edit Items on an order already in Zoho', () => {
  const request = require('supertest');
  const app = require('../src/app');
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  const made = [];
  let token, productId, spy;
  const mk = async (key, invoice = null) => {
    const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    const ref = `GM-TAXED-${stamp}-${key}`;
    await db.prepare(`INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status, is_inclusive_tax, zoho_invoice_number)
                      VALUES (?, ?, ?, 'ready_for_dispatch', 'credit', 1000, 'x', ?, ?, 'synced', 1, ?)`).run(ref, c, m, `ZSO-${stamp}-${key}`, `SO-X-${key}`, invoice);
    const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
    await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, discount_amount, tax_percent, line_total) VALUES (?, ?, 10, 100, 1000, 0, 12, 1000)').run(id, productId);
    made.push(id);
    return id;
  };
  const edit = (id, body) => request(app).patch(`/api/orders/${id}/items`).set({ Authorization: `Bearer ${token}` }).send(body);
  beforeAll(async () => {
    token = (await request(app).post('/api/auth/login').send({ email: 'manager@getmeds.ph', password: 'demo123' })).body.data.token;
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;
  });
  beforeEach(() => { spy = jest.spyOn(zoho, 'updateSalesOrder').mockResolvedValue({ code: 0, salesorder: {} }); });
  afterEach(() => spy.mockRestore());
  afterAll(async () => {
    for (const id of made) {
      for (const t of ['order_items', 'order_events', 'notifications']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('switching to Tax Exclusive is saved and sent to Zoho, with each line\'s tax', async () => {
    const id = await mk('a');
    const res = await edit(id, { is_inclusive_tax: false, items: [{ product_id: productId, quantity: 10, unit_price: 100, tax_percent: 0 }] });
    expect(res.status).toBe(200);
    expect((await db.prepare('SELECT is_inclusive_tax FROM orders WHERE id = ?').get(id)).is_inclusive_tax).toBe(0);
    const payload = spy.mock.calls[0][1];
    expect(payload.is_inclusive_tax).toBe(false);
    expect(payload.items.map((i) => Number(i.tax_percent))).toEqual([0]);
  });

  test('refused once Zoho has invoiced the order', async () => {
    const id = await mk('b', 'INV-TEST-1');
    const res = await edit(id, { is_inclusive_tax: false, items: [{ product_id: productId, quantity: 10, unit_price: 100, tax_percent: 12 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAX_PREFERENCE_LOCKED');
    expect(spy).not.toHaveBeenCalled();
  });
});
