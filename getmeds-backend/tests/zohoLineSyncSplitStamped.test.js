/**
 * A split order's primary lines are stamped with the order's OWN entity.
 *
 * Oct 16, 2026. GM-20261016-0015: PacliGet 260 + PacliGet 100mg on SO-68791
 * (2mg Incorporated, the order's own entity) and CarboGet 450 on SO-68792
 * (Getmeds Philippines Inc.). Edit Items stamps every line, so the two 2mg
 * lines were tagged "2mg Incorporated", not NULL. The line sync looked for
 * NULL only, saw an empty primary slice ("Was: none") and inserted SO-68791's
 * lines a second time: 5 lines and PHP 19,500 instead of 3 lines and 13,200.
 * The next Edit Items then pushed every line to the primary Sales Order.
 */

const db = require('../src/db/database');
const { syncLineItemsFromZoho } = require('../src/services/zohoLineSyncService');
const { buildZohoSalesOrderPayload } = require('../src/services/zohoPayloadBuilder');

const STAMP = Date.now();
const TWO_MG = '2mg Incorporated';
const GETMEDS = 'Getmeds Philippines Inc.';

describe('line sync on a split order whose primary lines carry the order entity', () => {
  let customerId, medrepId;
  const products = {};
  const createdOrderIds = [];
  const Z = { paclia: `ZI-PA-${STAMP}`, paclib: `ZI-PB-${STAMP}`, carbo: `ZI-CA-${STAMP}` };

  beforeAll(async () => {
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
    for (const [key, name] of [['paclia', 'PacliGet 260'], ['paclib', 'PacliGet 100mg'], ['carbo', 'CarboGet 450']]) {
      const sku = `SS-${key}-${STAMP}`;
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

  async function splitOrder() {
    const ref = `GM-SPLITSTAMP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, zoho_so_id, zoho_so_number, zoho_so_status, invoicing_from)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 13200, '1 Split St', ?, 'SO-SPLIT-A', 'draft', ?)`
      )
      .run(ref, customerId, medrepId, `ZSO-${ref}`, TWO_MG);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    const ins = db.prepare(
      'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total, invoicing_from) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await ins.run(id, products.paclia, 1, 3500, 3500, 3500, TWO_MG);
    await ins.run(id, products.paclib, 1, 2800, 2800, 2800, TWO_MG);
    await ins.run(id, products.carbo, 2, 3450, 6900, 6900, GETMEDS);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }

  const primarySalesOrder = () => ({
    salesorder_number: 'SO-SPLIT-A',
    status: 'draft',
    total: 6300,
    is_inclusive_tax: true,
    line_items: [
      { item_id: Z.paclia, name: 'PacliGet 260', quantity: 1, rate: 3500, discount: 0, tax_percentage: 0, tax_name: 'No Tax' },
      { item_id: Z.paclib, name: 'PacliGet 100mg', quantity: 1, rate: 2800, discount: 0, tax_percentage: 0, tax_name: 'No Tax' }
    ]
  });

  const itemCount = async (id) => Number((await db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(id)).n);
  const totalOf = async (id) => Number((await db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(id)).total_amount);

  test("syncing the primary Sales Order does not duplicate lines already stamped with the order's entity", async () => {
    const order = await splitOrder();
    expect(await syncLineItemsFromZoho({ order, salesorder: primarySalesOrder() })).toBe('unchanged');
    expect(await itemCount(order.id)).toBe(3);
    expect(await totalOf(order.id)).toBe(13200);
  });

  test('a real change to a primary line still syncs, and leaves the split entity alone', async () => {
    const order = await splitOrder();
    const so = primarySalesOrder();
    so.line_items[0].rate = 3000;
    so.total = 5800;
    expect(await syncLineItemsFromZoho({ order, salesorder: so })).toBe('synced');
    expect(await itemCount(order.id)).toBe(3);
    expect(await totalOf(order.id)).toBe(12700);
    const carbo = await db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(order.id, products.carbo);
    expect(carbo.invoicing_from).toBe(GETMEDS);
    expect(Number(carbo.line_total)).toBe(6900);
  });

  test("the primary Sales Order's payload carries only the primary entity's lines", async () => {
    const order = await splitOrder();
    const payload = await buildZohoSalesOrderPayload(order.id);
    expect(payload.items.map((i) => i.product_id).sort()).toEqual([products.paclia, products.paclib].sort());
    expect(Number(payload.total_amount)).toBe(6300);
  });

  test("a 'split' of the order's own entity, or a voided Sales Order, is never copied in", async () => {
    const order = await splitOrder();
    const split = primarySalesOrder();
    split.line_items = [{ item_id: Z.paclia, name: 'PacliGet 260', quantity: 1, rate: 3500, discount: 0, tax_percentage: 0, tax_name: 'No Tax' }];
    split.total = 3500;
    // Same entity as the order's own (2mg): not a real split.
    expect(await syncLineItemsFromZoho({ order, salesorder: split, invoicingFrom: TWO_MG })).toBe('skipped');
    // A void Sales Order for the other entity: skipped too.
    expect(await syncLineItemsFromZoho({ order, salesorder: { ...split, status: 'void' }, invoicingFrom: GETMEDS })).toBe('skipped');
    expect(await itemCount(order.id)).toBe(3);
    expect(await totalOf(order.id)).toBe(13200);
  });

  test('an order with no split still sends every line', async () => {
    const order = await splitOrder();
    await db.prepare('UPDATE order_items SET invoicing_from = NULL WHERE order_id = ?').run(order.id);
    const payload = await buildZohoSalesOrderPayload(order.id);
    expect(payload.items).toHaveLength(3);
    expect(Number(payload.total_amount)).toBe(13200);
  });
});
