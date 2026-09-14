/**
 * "Pull from Zoho" records each item's own sales tax.
 *
 * Sep 14, 2026. Zoho applies an item's tax to a Sales Order line whatever this
 * app sends — read back from the live org, a line for a "Vat" item carried 12%
 * and a line for a "No Tax" item carried 0%, regardless of the app. So the
 * order form now shows the item's tax instead of asking the MedRep for it, and
 * that only works if the sync records it.
 *
 * The item list is replaced with a spy rather than extending the shared mock
 * fixtures: other suites count what those fixtures produce, and a field added
 * for one test is how an unrelated suite starts failing.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

const SKU = `TAXSYNC-${Date.now()}`;
const ITEM_ID = `ITEM-TAX-${Date.now()}`;

describe('POST /api/inventory/sync-pull — item tax', () => {
  let adminToken;

  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM products WHERE sku = ?').run(SKU);
  });

  const item = (overrides) => ({
    item_id: ITEM_ID,
    name: 'Tax sync fixture',
    sku: SKU,
    rate: 50,
    stock_on_hand: 5,
    status: 'active',
    unit: 'pc',
    ...overrides
  });

  async function pull(items) {
    const spy = jest
      .spyOn(zoho, 'listItems')
      .mockResolvedValue({ code: 0, message: 'success', items, truncated: false });
    const res = await request(app)
      .post('/api/inventory/sync-pull')
      .set({ Authorization: `Bearer ${adminToken}` });
    spy.mockRestore();
    return res;
  }

  const row = () =>
    db.prepare('SELECT zoho_tax_id, tax_name, tax_percentage FROM products WHERE sku = ?').get(SKU);

  test('a new item arrives with its tax', async () => {
    const res = await pull([item({ tax_id: 'TAX-VAT', tax_name: 'Vat', tax_percentage: 12 })]);
    expect(res.status).toBe(200);

    const r = await row();
    expect(r.zoho_tax_id).toBe('TAX-VAT');
    expect(r.tax_name).toBe('Vat');
    expect(Number(r.tax_percentage)).toBe(12);
  });

  test('a change to the tax in Zoho reaches an existing product', async () => {
    // The update path, not the insert: the product exists from the test above.
    await pull([item({ tax_id: 'TAX-NONE', tax_name: 'No Tax', tax_percentage: 0 })]);

    const r = await row();
    expect(r.tax_name).toBe('No Tax');
    // 0 is a real rate, not "unknown" — it must not be stored as null.
    expect(r.tax_percentage).not.toBeNull();
    expect(Number(r.tax_percentage)).toBe(0);
  });

  test('an item Zoho reports with no tax at all is stored as unknown, not 0%', async () => {
    // Unknown falls back to the MedRep's pick on the order form; 0% would
    // silently force No Tax on an item nobody had checked.
    await pull([item({ tax_id: undefined, tax_name: undefined, tax_percentage: undefined })]);
    expect((await row()).tax_percentage).toBeNull();
  });
});
