'use strict';

/**
 * Isolated unit tests verifying SQL wiring, `.all([ids])` parameter shapes,
 * schemaColumns fallbacks, and classification attachment in dispatch.controller
 * and inventory.controller without touching any real PostgreSQL database.
 */
describe('Phase 1 controller & inventory sync wiring (mocked DB)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('dispatch.getSlip attaches classification, tin, lto_license_number, and warehouse fields safely', async () => {
    const mockGet = jest.fn().mockResolvedValue({
      id: 42,
      getmeds_order_id: 'GM-20261114-0015',
      status: 'ready_for_dispatch',
      division: 'B2B',
      intake_source: 'Distributor order',
      invoicing_from: '2mg Incorporated',
      fulfil_warehouse_id: 'WH-1',
      fulfil_warehouse_name: 'Getmeds Philippines Inc.',
      customer_name: 'GENECCCA PHARMACY',
      tin: '009-341-772-000',
      lto_license_number: 'FDA-LTO-300001884',
      customer_category: 'distributor',
      delivery_confirmed_at: null,
      delivery_confirmed_meta: null
    });

    const mockAll = jest.fn().mockImplementation(() => Promise.resolve([]));
    jest.doMock('../src/db/database', () => ({
      prepare: jest.fn((sql) => ({
        get: mockGet,
        run: jest.fn(),
        all: jest.fn((arg) => {
          if (/FROM order_items/i.test(sql) && arg === 42) {
            return Promise.resolve([
              { id: 10, product_id: 50, name: 'Adagrasib 200mg Tablet', sku: 'ADA-200', unit: 'BOX', is_csp: 1, quantity: 2 }
            ]);
          }
          if (/FROM order_items/i.test(sql)) {
            return Promise.resolve([
              { id: 10, order_id: 42, product_id: 50, invoicing_from: null, product_name: 'Adagrasib 200mg Tablet', is_csp: 1 }
            ]);
          }
          return mockAll(sql, arg);
        })
      })),
      transaction: jest.fn((fn) => fn)
    }));
    jest.doMock('../src/services/schemaColumns', () => ({
      hasColumn: jest.fn().mockResolvedValue(true)
    }));

    const dispatchCtrl = require('../src/controllers/dispatch.controller');
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })), json };
    const next = jest.fn();

    await dispatchCtrl.getSlip({ params: { id: 42 } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.order.tin).toBe('009-341-772-000');
    expect(payload.data.order.lto_license_number).toBe('FDA-LTO-300001884');
    expect(payload.data.order.fulfil_warehouse_name).toBe('Getmeds Philippines Inc.');
    expect(payload.data.order.classification).toMatchObject({
      transaction_kind: 'b2b',
      requires_si: true,
      requires_dr: true,
      is_csp: true,
      skip_so_print: true,
      primary_entity: '2MG'
    });
  });

  it('inventory.reconcileItems preserves existing is_csp on update and auto-tags new CSP inserts', async () => {
    const updateRuns = [];
    const insertRuns = [];

    jest.doMock('../src/db/database', () => ({
      prepare: jest.fn((sql) => {
        if (/SELECT id, name, sku, zoho_item_id, is_active FROM products/i.test(sql)) {
          return {
            all: jest.fn().mockResolvedValue([
              { id: 1, name: 'Existing Losartan', sku: 'LOS-50', zoho_item_id: 'Z-1', is_active: 1 }
            ])
          };
        }
        if (/^UPDATE products SET/i.test(sql.trim())) {
          return {
            sql,
            run: jest.fn((...args) => {
              updateRuns.push({ sql, args });
              return Promise.resolve({ changes: 1 });
            })
          };
        }
        if (/^INSERT INTO products/i.test(sql.trim())) {
          return {
            sql,
            run: jest.fn((...args) => {
              insertRuns.push({ sql, args });
              return Promise.resolve({ changes: 1, lastInsertRowid: 99 });
            })
          };
        }
        return { all: jest.fn().mockResolvedValue([]), get: jest.fn().mockResolvedValue(null), run: jest.fn() };
      }),
      transaction: jest.fn((fn) => async (...a) => fn(...a))
    }));
    jest.doMock('../src/services/schemaColumns', () => ({
      hasColumn: jest.fn().mockResolvedValue(true)
    }));

    const invCtrl = require('../src/controllers/inventory.controller');
    const res = await invCtrl.__test__.reconcileItems([
      { item_id: 'Z-1', name: 'Existing Losartan', sku: 'LOS-50', rate: 10, stock_on_hand: 100, status: 'active' },
      { item_id: 'Z-2', name: 'Nivolumab 100mg Vial', sku: 'NIV-100', rate: 101687, stock_on_hand: 5, status: 'active' },
      { item_id: 'Z-3', name: 'Anti Diarrheal 2mg', sku: 'AD-2', rate: 15, stock_on_hand: 20, status: 'active' }
    ]);

    expect(res).toMatchObject({ updatedCount: 1, createdCount: 2, skippedCount: 0 });
    expect(updateRuns).toHaveLength(1);
    expect(updateRuns[0].sql).not.toMatch(/is_csp/i); // Never overwrites existing is_csp on Zoho sync!
    expect(insertRuns).toHaveLength(2);
    // Nivolumab tagged is_csp=1; Anti Diarrheal stays is_csp=0
    expect(insertRuns[0].args[insertRuns[0].args.length - 1]).toBe(1);
    expect(insertRuns[1].args[insertRuns[1].args.length - 1]).toBe(0);
  });
});
