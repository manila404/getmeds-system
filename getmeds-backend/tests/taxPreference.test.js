/**
 * Tax on an order line: whose tax, and inside or on top of the rate.
 *
 * Sep 14, 2026. Two decisions, both made from what the live Zoho org actually
 * does rather than from what the app used to assume:
 *
 *   WHOSE TAX  used to be the item's own, unconditionally — Zoho applies each
 *              item's configured tax to a Sales Order line whatever the app
 *              sends, so a per-line pick could only ever disagree with what
 *              the customer is billed there.
 *
 *              Sep 18, 2026: reversed on request — tax is now editable per
 *              line for every item, and the client's pick wins whenever it
 *              sends one (falling back to the item's own Zoho tax only when
 *              it sends none at all). A known, accepted trade: this order's
 *              stored total can now diverge from what Zoho actually invoices
 *              once it syncs, for a product with its own configured tax —
 *              the order form and item editor both say so next to the
 *              control.
 *
 *   INSIDE OR ON TOP  inclusive by default. Read back from the live org, every
 *              Sales Order this app created was priced with VAT inside the rate.
 *              Exclusive is still available per order, and the choice is sent
 *              to Zoho so both sides price it the same way.
 *
 * The worked example throughout — 2 x PHP 100, PHP 20 off, VAT 12%:
 *
 *   inclusive:  200 - 20                 = 180.00   tax 180 x 12/112 = 19.29
 *   exclusive: (200 - 20) x 1.12         = 201.60   tax 21.60
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { computeLine, parseInclusiveTax } = require('../src/services/lineAmounts');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('computeLine', () => {
  test('exclusive adds VAT on top of the discounted line', () => {
    const r = computeLine({ subtotal: 200, discount: 20, taxPercent: 12, inclusive: false });
    expect(r.discountAmount).toBe(20);
    expect(r.taxAmount).toBeCloseTo(21.6, 6);
    expect(r.lineTotal).toBeCloseTo(201.6, 6);
  });

  test('inclusive keeps the discounted line as the total and extracts the VAT', () => {
    const r = computeLine({ subtotal: 200, discount: 20, taxPercent: 12, inclusive: true });
    expect(r.lineTotal).toBeCloseTo(180, 6);
    expect(r.taxAmount).toBeCloseTo((180 * 12) / 112, 6);
  });

  test('with no tax the two preferences agree', () => {
    const ex = computeLine({ subtotal: 200, discount: 20, taxPercent: 0, inclusive: false });
    const inc = computeLine({ subtotal: 200, discount: 20, taxPercent: 0, inclusive: true });
    expect(inc.lineTotal).toBe(ex.lineTotal);
    expect(inc.taxAmount).toBe(0);
  });

  test('a discount larger than the line is capped at the line', () => {
    const r = computeLine({ subtotal: 100, discount: 500, taxPercent: 12, inclusive: false });
    expect(r.discountAmount).toBe(100);
    expect(r.lineTotal).toBe(0);
  });

  test('blank discount and tax mean none, not an error', () => {
    const r = computeLine({ subtotal: 50, discount: '', taxPercent: undefined });
    expect(r.lineTotal).toBe(50);
  });

  test('the shapes a body or a form send for "inclusive" are all understood', () => {
    for (const yes of [true, 1, '1', 'true', 'TRUE', 'inclusive']) expect(parseInclusiveTax(yes)).toBe(true);
    for (const no of [false, 0, '0', 'false', '', undefined, null, 'exclusive']) expect(parseInclusiveTax(no)).toBe(false);
  });
});

describe('tax through the order API', () => {
  let managerToken, ownerToken;
  let customerId, plainProductId, vatProductId, noTaxProductId, medrepId, ownerId;
  const createdOrderIds = [];
  const createdUserIds = [];
  const createdProductIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    ownerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('medrep@getmeds.ph')).id;

    // Own manager, so the order skips the approval queue and its totals are
    // written in one request.
    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const email = `mgr-tax-${Date.now()}@getmeds.ph`;
    await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'management')")
      .run('Tax Manager', email, seed.password_hash);
    createdUserIds.push((await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id);
    managerToken = await loginAs(email);

    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;

    // Products of our own, rather than editing the shared fixtures: one never
    // pulled from Zoho (no tax recorded), one Zoho taxes at Vat 12%, and one
    // Zoho marks No Tax.
    const stamp = Date.now();
    const makeProduct = async (label, taxName, taxPct) => {
      const sku = `TAX-${label}-${stamp}`;
      await db
        .prepare(
          `INSERT INTO products (name, sku, unit_price, unit, stock, is_active, tax_name, tax_percentage)
           VALUES (?, ?, 100, 'pcs', 1000, 1, ?, ?)`
        )
        .run(`Tax fixture ${label}`, sku, taxName, taxPct);
      const { id } = await db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
      createdProductIds.push(id);
      return id;
    };
    plainProductId = await makeProduct('PLAIN', null, null);
    vatProductId = await makeProduct('VAT', 'Vat', 12);
    noTaxProductId = await makeProduct('NOTAX', 'No Tax', 0);
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdProductIds) await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  async function create({ productId, taxPercent = 12, extra = {} }) {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(managerToken))
      .send({
        customer_id: customerId,
        medrep_id: medrepId,
        delivery_address: '1 Tax St',
        items: [{ product_id: productId, quantity: 2, rate: 100, discount: 20, tax_percent: taxPercent, tax_label: 'client label' }],
        ...extra
      });
    expect([200, 201]).toContain(res.status);
    const id = res.body.data.order.id;
    createdOrderIds.push(id);
    return id;
  }

  const orderRow = (id) =>
    db.prepare('SELECT total_amount, is_inclusive_tax FROM orders WHERE id = ?').get(id);
  const itemRow = (id) =>
    db.prepare('SELECT line_total, tax_percent, tax_label FROM order_items WHERE order_id = ?').get(id);

  test('an order that states no preference is Tax Inclusive', async () => {
    // The default the live org already applies to every order this app sends.
    const id = await create({ productId: plainProductId });
    const row = await orderRow(id);
    expect(Number(row.total_amount)).toBeCloseTo(180, 6);
    expect(Number(row.is_inclusive_tax)).toBe(1);
  });

  test('Tax Exclusive is still available when an order asks for it', async () => {
    const id = await create({ productId: plainProductId, extra: { is_inclusive_tax: false } });
    const row = await orderRow(id);
    expect(Number(row.total_amount)).toBeCloseTo(201.6, 6);
    expect(Number(row.is_inclusive_tax)).toBe(0);
  });

  test('Sep 18, 2026: what the client sends now wins over the item\'s Zoho tax', async () => {
    // The client says No Tax on an item Zoho taxes at 12% — the client's
    // pick is what is priced and stored here now (Zoho will still apply its
    // own 12% once this order syncs; the two are allowed to diverge).
    const id = await create({ productId: vatProductId, taxPercent: 0, extra: { is_inclusive_tax: false } });
    expect(Number((await orderRow(id)).total_amount)).toBeCloseTo(180, 6);
    const item = await itemRow(id);
    expect(Number(item.tax_percent)).toBe(0);
  });

  test('an item Zoho marks No Tax can still be taxed here if the client picks VAT', async () => {
    const id = await create({ productId: noTaxProductId, taxPercent: 12, extra: { is_inclusive_tax: false } });
    expect(Number((await orderRow(id)).total_amount)).toBeCloseTo(201.6, 6);
    expect(Number((await itemRow(id)).tax_percent)).toBe(12);
    expect((await itemRow(id)).tax_label).toBe('client label');
  });

  test('sending no tax_percent at all still falls back to the item\'s own Zoho tax', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(managerToken))
      .send({
        customer_id: customerId,
        medrep_id: medrepId,
        delivery_address: '1 Tax St',
        is_inclusive_tax: false,
        items: [{ product_id: vatProductId, quantity: 2, rate: 100, discount: 20 }]
      });
    expect([200, 201]).toContain(res.status);
    createdOrderIds.push(res.body.data.order.id);
    const item = await itemRow(res.body.data.order.id);
    expect(Number(item.tax_percent)).toBe(12);
    expect(item.tax_label).toBe('Vat');
  });

  test('a product not yet pulled from Zoho uses what the client sent', async () => {
    // The fallback, until "Pull from Zoho" has recorded the item's tax.
    const id = await create({ productId: plainProductId, taxPercent: 12, extra: { is_inclusive_tax: false } });
    expect(Number((await itemRow(id)).tax_percent)).toBe(12);
  });

  test('editing the items of an inclusive order keeps it inclusive', async () => {
    // Without a stored preference driving updateItems, the first edit would
    // re-price as exclusive and put VAT on top of rates that already held it.
    const ref = `TAXEDIT-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, is_inclusive_tax)
         VALUES (?, ?, ?, 'draft', 'direct', 0, '1 Tax St', 1)`
      )
      .run(ref, customerId, ownerId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);

    const res = await request(app)
      .patch(`/api/orders/${id}/items`)
      .set(auth(ownerToken))
      .send({ items: [{ product_id: vatProductId, quantity: 2, rate: 100, discount: 20 }] });
    expect(res.status).toBe(200);

    expect(Number((await orderRow(id)).total_amount)).toBeCloseTo(180, 6);
  });

  test('the preference is sent to Zoho on the Sales Order', async () => {
    // Zoho applies the item tax either way; this flag decides whether that VAT
    // sits inside the rate or on top, so without it the two would disagree.
    const zoho = require('../src/integrations/zoho');
    const spy = jest.spyOn(zoho, 'createSalesOrder');
    await create({ productId: plainProductId, extra: { is_inclusive_tax: false } });
    const sent = spy.mock.calls[spy.mock.calls.length - 1][0];
    expect(sent.is_inclusive_tax).toBe(false);
    spy.mockRestore();
  });
});
