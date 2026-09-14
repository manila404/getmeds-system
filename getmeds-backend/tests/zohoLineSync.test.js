/**
 * An edit made in Zoho reaches the order's items and total.
 *
 * Sep 14, 2026. The webhook and "Sync from Zoho" both noticed a Zoho edit but
 * compared only seven header fields, so GM-20260913-0001 kept PHP 6,973.08 and
 * a product Zoho had swapped out, while its trail — copying Zoho's history —
 * said the amount was now PHP 5,440.00. The fixture below is that order.
 *
 *   before (app):  PacliGet 260 @ 6,973.08 ; Carboplatin 450 @ 0
 *   Zoho now:      PacliGet 260 @ 2,580 ; CarboGet 450 @ 2,675 ;
 *                  IV Infusion Set @ 185 (VAT 12%, inclusive)   = 5,440.00
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { syncLineItemsFromZoho } = require('../src/services/zohoLineSyncService');

const SEED_PASSWORD = 'demo123';
async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

const STAMP = Date.now();
const Z = { pacli: `ZI-PACLI-${STAMP}`, carbo: `ZI-CARBO-${STAMP}`, carboOld: `ZI-CARBOOLD-${STAMP}`, set: `ZI-SET-${STAMP}` };

describe('syncing line items from a Zoho Sales Order', () => {
  let adminToken, customerId, medrepId;
  const products = {};
  const createdOrderIds = [];

  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
    for (const [key, name] of [['pacli', 'PacliGet 260'], ['carbo', 'CarboGet 450'], ['carboOld', 'Carboplatin 450'], ['set', 'IV Infusion Set']]) {
      const sku = `LS-${key}-${STAMP}`;
      await db
        .prepare("INSERT INTO products (name, sku, unit_price, unit, stock, is_active, zoho_item_id) VALUES (?, ?, 100, 'pcs', 100, 1, ?)")
        .run(`${name} ${STAMP}`, sku, Z[key]);
      products[key] = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(sku)).id;
    }
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of Object.values(products)) await db.prepare('DELETE FROM products WHERE id = ?').run(id);
  });

  /** The app's stale copy of GM-20260913-0001. */
  async function staleOrder(ref = `GM-LINESYNC-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`) {
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_so_status)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 6973.08, '1 Sync St', ?, 'SO-SYNC', 'draft')`
      )
      .run(ref, customerId, medrepId, `ZSO-${ref}`);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    const ins = db.prepare(
      'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total) VALUES (?, ?, 1, ?, ?, ?)'
    );
    await ins.run(id, products.pacli, 6973.08, 6973.08, 6973.08);
    await ins.run(id, products.carboOld, 0, 0, 0);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }

  /** SO-67411 as Zoho reports it now. */
  const zohoSalesOrder = (overrides = {}) => ({
    salesorder_number: 'SO-SYNC',
    status: 'draft',
    total: 5440,
    is_inclusive_tax: true,
    line_items: [
      { item_id: Z.pacli, name: 'PacliGet 260', quantity: 1, rate: 2580, discount: 0, tax_percentage: 0, tax_name: 'No Tax' },
      { item_id: Z.carbo, name: 'CarboGet 450', quantity: 1, rate: 2675, discount: 0, tax_percentage: 0, tax_name: 'No Tax' },
      { item_id: Z.set, name: 'IV Infusion Set', quantity: 1, rate: 185, discount: 0, tax_percentage: 12, tax_name: 'Vat' }
    ],
    ...overrides
  });

  const itemsOf = (id) =>
    db.prepare('SELECT product_id, quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY unit_price DESC').all(id);
  const eventsOf = (id, type) =>
    db.prepare('SELECT * FROM order_events WHERE order_id = ? AND event_type = ?').all(id, type);

  test('the items and total become what Zoho has — including a swapped product and an added line', async () => {
    const order = await staleOrder();
    expect(await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder() })).toBe('synced');

    const items = await itemsOf(order.id);
    expect(items.map((r) => r.product_id)).toEqual([products.carbo, products.pacli, products.set]);
    expect(items.map((r) => Number(r.unit_price))).toEqual([2675, 2580, 185]);
    // Priced the way Zoho prices it: the 185 line is VAT-inclusive, so it adds
    // 185 to the total, not 185 + 12%.
    expect(items.reduce((s, r) => s + Number(r.line_total), 0)).toBeCloseTo(5440, 6);
    expect(Number((await db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(order.id)).total_amount)).toBe(5440);

    const [ev] = await eventsOf(order.id, 'ZOHO_SO_ITEMS_SYNCED');
    expect(ev.notes).toMatch(/6,973\.08.*5,440\.00/);
  });

  test('a second sync with nothing new changes nothing and logs nothing', async () => {
    const order = await staleOrder();
    await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder() });
    expect(await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder() })).toBe('unchanged');
    expect(await eventsOf(order.id, 'ZOHO_SO_ITEMS_SYNCED')).toHaveLength(1);
  });

  test('a line with no local product leaves the items alone and says why, once', async () => {
    const order = await staleOrder();
    const so = zohoSalesOrder({
      line_items: [...zohoSalesOrder().line_items, { item_id: 'ZI-NOBODY', name: 'Unknown Thing', quantity: 1, rate: 50, tax_percentage: 0 }]
    });
    expect(await syncLineItemsFromZoho({ order, salesorder: so })).toBe('refused');
    expect(await syncLineItemsFromZoho({ order, salesorder: so })).toBe('refused');

    expect((await itemsOf(order.id)).map((r) => Number(r.unit_price))).toEqual([6973.08, 0]);
    const warned = await eventsOf(order.id, 'ZOHO_SO_ITEMS_NOT_SYNCED');
    expect(warned).toHaveLength(1);
    expect(warned[0].notes).toMatch(/Unknown Thing/);
  });

  test('a fractional quantity is refused rather than aborting the write', async () => {
    const order = await staleOrder();
    const so = zohoSalesOrder({ line_items: [{ item_id: Z.pacli, name: 'PacliGet 260', quantity: 0.5, rate: 2580, tax_percentage: 0 }], total: 1290 });
    expect(await syncLineItemsFromZoho({ order, salesorder: so })).toBe('refused');
    expect(Number((await db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(order.id)).total_amount)).toBe(6973.08);
  });

  test('a partial Sales Order (no rates or no total) is never synced from', async () => {
    // The shape the test mock returns, and the shape a truncated API response
    // would have. Syncing from it would zero every price on the order.
    const order = await staleOrder();
    const noRates = zohoSalesOrder({ line_items: [{ item_id: Z.pacli, quantity: 1 }] });
    expect(await syncLineItemsFromZoho({ order, salesorder: noRates })).toBe('skipped');
    expect(await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder({ total: undefined }) })).toBe('skipped');
    expect(await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder({ line_items: [] }) })).toBe('skipped');
    expect((await itemsOf(order.id)).length).toBe(2);
  });

  test('an order imported from Zoho is not touched', async () => {
    const order = await staleOrder(`ZOHO-SO-LS-${Date.now()}`);
    expect(await syncLineItemsFromZoho({ order, salesorder: zohoSalesOrder() })).toBe('skipped');
    expect((await itemsOf(order.id)).length).toBe(2);
  });

  test('"Sync from Zoho" on the order applies it end to end', async () => {
    // The path GM-20260913-0001 needs: reconcile fetches the Sales Order and
    // now carries the items across as well as the header fields.
    const order = await staleOrder();
    const getSpy = jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ code: 0, salesorder: zohoSalesOrder() });
    const commentsSpy = jest.spyOn(zoho, 'listSalesOrderComments').mockResolvedValue({ code: 0, comments: [] });

    const res = await request(app)
      .post(`/api/orders/${order.id}/sync-from-zoho`)
      .set({ Authorization: `Bearer ${adminToken}` });
    getSpy.mockRestore();
    commentsSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(Number((await db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(order.id)).total_amount)).toBe(5440);
    expect((await itemsOf(order.id)).length).toBe(3);
  });
});
