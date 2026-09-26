/**
 * Sep 26, 2026 — "Sync from Zoho" on a split order reads BOTH Sales Orders.
 *
 * GM-20260926-0013 is split across SO-67981 (2mg Incorporated, the primary) and
 * SO-67982 (Getmeds Philippines Inc.). SO-67982 was invoiced and shipped in Zoho and
 * had two lines added there; GetMeds showed none of it because every sync path read
 * only the primary. Pinned here: the second Sales Order's items, total, invoice,
 * package and shipment come in, once, and a second sync changes nothing.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { reconcileSplitOrders, deriveSplitState } = require('../src/services/zohoSplitReconcileService');

const stamp = Date.now();
const ENTITY = 'Getmeds Philippines Inc.';
let orderId, splitId, products, adminToken, primaryItemTotal;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}

const line = (p, qty, rate) => ({ item_id: p.zoho_item_id || undefined, sku: p.sku, name: p.name, quantity: qty, rate, item_total: qty * rate });
const splitSalesOrder = (over = {}) => ({
  salesorder_id: `ZSO-SPLIT-${stamp}`,
  salesorder_number: `SO-SPLIT-${stamp}`,
  status: 'confirmed',
  total: 8836.54,
  line_items: [line(products[1], 1, 5782.54), line(products[2], 1, 3054)],
  invoices: [{ invoice_id: 'INV-ID-1', invoice_number: 'INV-SPLIT-1', status: 'sent' }],
  packages: [{ package_id: 'PKG-ID-1', package_number: 'PKG-1', status: 'shipped', shipment_status: 'shipped', shipment_order: { shipment_id: 'SHP-ID-1', shipment_number: 'SHP-1' } }],
  shipped_status: 'shipped',
  ...over,
});

describe('reconcileSplitOrders', () => {
  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    products = [];
    for (let i = 0; i < 3; i += 1) {
      const sku = 'SPLITREC-' + stamp + '-' + i;
      await db.prepare('INSERT INTO products (name, sku, unit_price, stock) VALUES (?, ?, ?, 100)').run('Split Rec Product ' + i, sku, 100);
      products.push(await db.prepare('SELECT id, name, sku, zoho_item_id FROM products WHERE sku = ?').get(sku));
    }
    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    const ref = `GM-SPLITREC-${stamp}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address,
                             invoicing_from, zoho_so_id, zoho_so_number)
         VALUES (?, ?, ?, 'tracking_shared', 'direct', 0, '1 Split St', '2mg Incorporated', ?, ?)`
      )
      .run(ref, customerId, medrepId, `ZSO-PRIMARY-${stamp}`, `SO-PRIMARY-${stamp}`);
    orderId = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;

    const item = (p, rate, from) =>
      db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, discount_amount, tax_percent, line_total, invoicing_from)
           VALUES (?, ?, 1, ?, ?, 0, 0, ?, ?)`
        )
        .run(orderId, p.id, rate, rate, rate, from);
    await item(products[0], 13234.02, null); // the primary's line
    await item(products[1], 5782.54, ENTITY); // the split's only line so far
    primaryItemTotal = 13234.02;
    await db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(13234.02 + 5782.54, orderId);

    splitId = (
      await db
        .prepare(
          `INSERT INTO order_split_sales_orders (order_id, invoicing_from, zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status)
           VALUES (?, ?, ?, ?, 'draft', 'synced')`
        )
        .run(orderId, ENTITY, `ZSO-SPLIT-${stamp}`, `SO-SPLIT-${stamp}`)
    ).lastInsertRowid;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM order_split_sales_orders WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    for (const p of products) await db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  });

  test('deriveSplitState reads status, invoice, package and shipment', () => {
    const s = deriveSplitState(splitSalesOrder());
    expect(s.soStatus).toBe('confirmed');
    expect(s.invoice).toEqual({ id: 'INV-ID-1', number: 'INV-SPLIT-1', stage: 'sent', paid: false });
    expect(s.package).toEqual({ id: 'PKG-ID-1', number: 'PKG-1' });
    expect(s.shipped).toBe(true);
    expect(deriveSplitState({ status: 'void' }).soStatus).toBe('cancelled');
    expect(deriveSplitState({ status: 'confirmed', invoices: [{ invoice_id: 'X', status: 'void' }] }).invoice).toBeNull();
  });

  test('brings in the second Sales Order: items, total, invoice, package, shipment', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ salesorder: splitSalesOrder() });
    const res = await reconcileSplitOrders({ orderId, actorName: 'test', source: 'manual_reconcile' });
    expect(res.changed).toBe(true);
    expect(res.splits[0].error).toBeNull();

    const row = await db.prepare('SELECT * FROM order_split_sales_orders WHERE id = ?').get(splitId);
    expect(row.zoho_so_status).toBe('confirmed');
    expect(row.zoho_invoice_number).toBe('INV-SPLIT-1');
    expect(row.zoho_invoiced_status).toBe('sent');
    expect(row.zoho_package_id).toBe('PKG-ID-1');
    expect(row.zoho_shipped_status).toBe('shipped');
    expect(row.zoho_shipment_number).toBe('SHP-1');

    const splitItems = await db.prepare('SELECT product_id FROM order_items WHERE order_id = ? AND invoicing_from = ?').all(orderId, ENTITY);
    expect(splitItems.map((i) => i.product_id).sort()).toEqual([products[1].id, products[2].id].sort());
    const primaryItems = await db.prepare('SELECT product_id FROM order_items WHERE order_id = ? AND invoicing_from IS NULL').all(orderId);
    expect(primaryItems.map((i) => i.product_id)).toEqual([products[0].id]);

    const order = await db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(orderId);
    expect(Number(order.total_amount)).toBeCloseTo(primaryItemTotal + 5782.54 + 3054, 2);

    const events = await db.prepare("SELECT event_type, notes FROM order_events WHERE order_id = ? AND notes LIKE ?").all(orderId, `[${ENTITY}]%`);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['ZOHO_SO_CONFIRMED', 'ZOHO_INVOICE_SENT', 'ZOHO_PACKAGE_CREATED', 'ZOHO_DISPATCHED']));
  });

  test('a second sync changes nothing and logs nothing', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ salesorder: splitSalesOrder() });
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?').get(orderId)).n;
    const res = await reconcileSplitOrders({ orderId, actorName: 'test', source: 'manual_reconcile' });
    expect(res.changed).toBe(false);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?').get(orderId)).n).toBe(before);
  });

  test('a paid invoice is recorded once', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ salesorder: splitSalesOrder({ invoices: [{ invoice_id: 'INV-ID-1', invoice_number: 'INV-SPLIT-1', status: 'paid' }] }) });
    await reconcileSplitOrders({ orderId });
    await reconcileSplitOrders({ orderId });
    const row = await db.prepare('SELECT zoho_paid_status FROM order_split_sales_orders WHERE id = ?').get(splitId);
    expect(row.zoho_paid_status).toBe('paid');
    const n = await db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_PAYMENT_VERIFIED'").get(orderId);
    expect(Number(n.n)).toBe(1);
  });

  test('a Zoho failure on the split is reported, not thrown, and nothing is changed', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('Zoho is down'));
    const res = await reconcileSplitOrders({ orderId });
    expect(res.changed).toBe(false);
    expect(res.splits[0].error).toMatch(/Zoho is down/);
  });

  test('an order with no split is a no-op', async () => {
    const ref = 'GM-PLAINREC-' + stamp;
    const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    await db.prepare("INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address) VALUES (?, ?, ?, 'draft', 'direct', 1, 'x')").run(ref, c, m);
    const other = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    expect(await reconcileSplitOrders({ orderId: other.id })).toEqual({ splits: [], changed: false });
    await db.prepare('DELETE FROM orders WHERE id = ?').run(other.id);
  });

  test('Sync from Zoho returns the split results', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockImplementation(async (id) => {
      if (String(id).startsWith('ZSO-SPLIT')) return { salesorder: splitSalesOrder() };
      return { salesorder: { salesorder_id: id, salesorder_number: 'SO-PRIMARY', status: 'confirmed', total: 1, line_items: [], invoices: [], packages: [] } };
    });
    const res = await request(app).post(`/api/orders/${orderId}/sync-from-zoho`).set({ Authorization: `Bearer ${adminToken}` }).send({});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.splits)).toBe(true);
    expect(res.body.data.splits[0].invoicing_from).toBe(ENTITY);
  });
});
