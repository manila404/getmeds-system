/**
 * An edited line's VAT choice must reach the Zoho Sales Order. Oct 2, 2026.
 * Only edits (sendLineTax) send it; creates are unchanged.
 */
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');

const build = (items, opts) => {
  const self = Object.create(LiveZohoAdapter.prototype);
  self._resolveSalespersonId = async () => 'SP1'; // no network
  return LiveZohoAdapter.prototype._buildSalesOrderBody.call(
    self,
    { getmeds_order_id: 'GM-TEST', salesperson_name: 'B2C | Test', items },
    opts
  );
};

describe('Sales Order line tax on edit', () => {
  const items = [
    { name: 'A', quantity: 1, unit_price: 10, tax_percent: 12 },
    { name: 'B', quantity: 1, unit_price: 10, tax_percent: 0 },
    { name: 'C', quantity: 1, unit_price: 10, tax_percent: 5 },
    { name: 'D', quantity: 1, unit_price: 10 }
  ];

  test('an edit sends Vat for 12%, No Tax for 0%, and leaves other/unknown to Zoho', async () => {
    const body = await build(items, { sendLineTax: true });
    const [a, b, c, d] = body.line_items;
    expect(a.tax_id).toBe('2254168000000078097');
    expect(b.tax_id).toBe('2254168000001813001');
    expect(c.tax_id).toBeUndefined();
    expect(d.tax_id).toBeUndefined();
  });

  test('a create does not send line tax', async () => {
    const body = await build(items);
    expect(body.line_items.every((l) => l.tax_id === undefined)).toBe(true);
  });
});
