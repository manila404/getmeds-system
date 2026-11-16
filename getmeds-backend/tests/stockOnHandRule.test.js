// Nov 16, 2026 (Aaron): stock ON HAND decides the approval stock check. Boxes Zoho still holds for
// other open Sales Orders (often stale, e.g. SO-62450 never shipped) warn but do not block.
jest.mock('../src/db/database', () => ({
  prepare: (sql) => ({
    get: async () => ({ id: 1, fulfil_warehouse_id: null }),
    all: async () => (/order_items/.test(sql)
      ? [{ line_id: 10, quantity: 1, line_warehouse_id: null, product_id: 6162, name: 'Anti D 300mcg/ml', sku: 'GM-4565', unit: 'Box', zoho_item_id: 'ANTI' },
         { line_id: 11, quantity: 3, line_warehouse_id: null, product_id: 7, name: 'Short item', sku: 'X', unit: 'pc', zoho_item_id: 'SHORT' }]
      : []),
  }),
}));
jest.mock('../src/integrations/zoho', () => ({
  getItemWarehouses: async (id) => ({
    warehouses: id === 'ANTI'
      ? [{ warehouse_id: 'W1', warehouse_name: 'Getmeds Philippines Inc.', is_primary: true, status: 'active',
          warehouse_stock_on_hand: 2, warehouse_committed_stock: 2, warehouse_available_for_sale_stock: 0 }]
      : [{ warehouse_id: 'W1', warehouse_name: 'Getmeds Philippines Inc.', is_primary: true, status: 'active',
          warehouse_stock_on_hand: 1, warehouse_committed_stock: 0, warehouse_available_for_sale_stock: 1 }],
  }),
}));
const { checkOrderStock, _clearCache } = require('../src/services/stockCheckService');

test('on hand covers the order even when Zoho has it committed elsewhere', async () => {
  _clearCache();
  const d = await checkOrderStock(1);
  const anti = d.lines.find((l) => l.sku === 'GM-4565');
  expect(anti.status).toBe('ok');
  expect(anti.committed_conflict).toBe(true);
  expect(anti.short_by).toBe(0);
});

test('a line with too little on hand is still short, by the on-hand gap', async () => {
  _clearCache();
  const d = await checkOrderStock(1);
  const s = d.lines.find((l) => l.sku === 'X');
  expect(s.status).toBe('short');
  expect(s.short_by).toBe(2);
  expect(s.committed_conflict).toBe(false);
});
