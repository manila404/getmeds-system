'use strict';

const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
const {
  DispatchBatchError,
  warehouseBalanceForBatch,
  filterAndSortBatchesForWarehouse,
  suggestFefoPicks,
  validatePickedBatches
} = require('../src/services/dispatchBatchService');

describe('FEFO warehouse batch filtering & validation', () => {
  const sampleZohoBatches = [
    {
      batch_id: 'B-EXP',
      batch_in_id: 'BI-EXP',
      batch_number: 'EXP-01',
      expiry_date: '2026-10-01',
      status: 'active',
      balance_quantity: 100,
      associated_warehouses: [{ warehouse_id: 'W-MAIN', balance_quantity: 100 }]
    },
    {
      batch_id: 'B-LATER',
      batch_in_id: 'BI-LATER',
      batch_number: 'LOT-LATER',
      expiry_date: '2028-05-01',
      status: 'active',
      balance_quantity: 200,
      associated_warehouses: [
        { warehouse_id: 'W-MAIN', balance_quantity: 120 },
        { warehouse_id: 'W-CEBU', balance_quantity: 80 }
      ]
    },
    {
      batch_id: 'B-SOONER',
      batch_in_id: 'BI-SOONER',
      batch_number: 'LOT-SOONER',
      expiry_date: '2027-02-15',
      status: 'active',
      balance_quantity: 70,
      associated_warehouses: [
        { warehouse_id: 'W-MAIN', balance_quantity: 40 },
        { warehouse_id: 'W-CEBU', balance_quantity: 30 }
      ]
    }
  ];

  it('extracts per-warehouse balance from associated_warehouses and sorts FEFO', () => {
    expect(warehouseBalanceForBatch(sampleZohoBatches[1], 'W-MAIN')).toBe(120);
    expect(warehouseBalanceForBatch(sampleZohoBatches[1], 'W-CEBU')).toBe(80);
    expect(warehouseBalanceForBatch(sampleZohoBatches[1], 'W-DAVAO')).toBe(0);

    const sortedMain = filterAndSortBatchesForWarehouse(sampleZohoBatches, 'W-MAIN', { today: '2026-11-16' });
    expect(sortedMain.map((b) => [b.batch_number, b.available_quantity, b.is_expired])).toEqual([
      ['LOT-SOONER', 40, false],
      ['LOT-LATER', 120, false],
      ['EXP-01', 100, true]
    ]);
  });

  it('picks earliest valid single FEFO batch that covers full quantity and skips expired lots', () => {
    const sorted = filterAndSortBatchesForWarehouse(sampleZohoBatches, 'W-MAIN', { today: '2026-11-16' });
    // LOT-SOONER only has 40, while LOT-LATER has 120 -> picks LOT-LATER in 1 single batch
    const suggestion = suggestFefoPicks(sorted, 100);
    expect(suggestion.unallocated_quantity).toBe(0);
    expect(suggestion.no_single_batch).toBe(false);
    expect(suggestion.picks).toEqual([
      expect.objectContaining({ batch_number: 'LOT-LATER', quantity: 100 })
    ]);

    // When no single batch covers 150, flags no_single_batch + unallocated shortfall so Dispatch can Hold or manually split
    const shortSuggestion = suggestFefoPicks(sorted, 150);
    expect(shortSuggestion.no_single_batch).toBe(true);
    expect(shortSuggestion.unallocated_quantity).toBe(110);
    expect(shortSuggestion.picks).toEqual([
      expect.objectContaining({ batch_number: 'LOT-SOONER', quantity: 40 })
    ]);
  });

  it('rejects expired batches, cross-warehouse batches, over-allocation, and wrong totals', () => {
    const sortedMain = filterAndSortBatchesForWarehouse(sampleZohoBatches, 'W-MAIN', { today: '2026-11-16' });
    const items = [{ id: 10, product_name: 'Meropenem 1g', quantity: 50, effective_warehouse_id: 'W-MAIN', is_csp: 0 }];
    const availMap = new Map([[10, sortedMain]]);

    expect(() =>
      validatePickedBatches({
        items,
        availableBatchesByItemId: availMap,
        picksByItemId: new Map([[10, [{ order_item_id: 10, batch_number: 'EXP-01', quantity: 50 }]]]),
        today: '2026-11-16'
      })
    ).toThrow(/expired/i);

    expect(() =>
      validatePickedBatches({
        items,
        availableBatchesByItemId: availMap,
        picksByItemId: new Map([[10, [{ order_item_id: 10, batch_number: 'LOT-DAVAO-ONLY', quantity: 50 }]]]),
        today: '2026-11-16'
      })
    ).toThrow(/not available in/i);

    expect(() =>
      validatePickedBatches({
        items,
        availableBatchesByItemId: availMap,
        picksByItemId: new Map([[10, [{ order_item_id: 10, batch_number: 'LOT-SOONER', quantity: 50 }]]]),
        today: '2026-11-16'
      })
    ).toThrow(/only has 40 available/i);

    expect(() =>
      validatePickedBatches({
        items,
        availableBatchesByItemId: availMap,
        picksByItemId: new Map([[10, [{ order_item_id: 10, batch_number: 'LOT-SOONER', quantity: 30 }]]]),
        today: '2026-11-16'
      })
    ).toThrow(/must equal ordered qty/i);
  });

  it('tracks B1T1 / duplicate-medicine lines independently by order_item_id and exempts CSP lines', () => {
    const sortedMain = filterAndSortBatchesForWarehouse(sampleZohoBatches, 'W-MAIN', { today: '2026-11-16' });
    const items = [
      { id: 101, product_id: 7, product_name: 'Meropenem 1g', quantity: 20, effective_warehouse_id: 'W-MAIN', is_csp: 0 },
      { id: 102, product_id: 7, product_name: 'Meropenem 1g', quantity: 20, effective_warehouse_id: 'W-MAIN', is_csp: 0 },
      { id: 103, product_id: 8, product_name: 'Adagrasib 200mg', quantity: 1, effective_warehouse_id: null, is_csp: 1 }
    ];
    const availMap = new Map([
      [101, sortedMain],
      [102, sortedMain],
      [103, []]
    ]);
    const picksMap = new Map([
      [101, [{ order_item_id: 101, batch_number: 'LOT-SOONER', quantity: 20 }]],
      [102, [{ order_item_id: 102, batch_number: 'LOT-LATER', quantity: 20 }]]
    ]);
    const res = validatePickedBatches({ items, availableBatchesByItemId: availMap, picksByItemId: picksMap, today: '2026-11-16' });
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ order_item_id: 101, batch_number: 'LOT-SOONER', quantity: 20 });
    expect(res[1]).toMatchObject({ order_item_id: 102, batch_number: 'LOT-LATER', quantity: 20 });

    // Cumulative cross-line check: LOT-SOONER only has 40 in W-MAIN, so taking 30 + 20 = 50 must fail!
    expect(() =>
      validatePickedBatches({
        items: [
          { id: 101, product_id: 7, product_name: 'Meropenem 1g', quantity: 30, effective_warehouse_id: 'W-MAIN', is_csp: 0 },
          { id: 102, product_id: 7, product_name: 'Meropenem 1g', quantity: 20, effective_warehouse_id: 'W-MAIN', is_csp: 0 }
        ],
        availableBatchesByItemId: availMap,
        picksByItemId: new Map([
          [101, [{ order_item_id: 101, batch_number: 'LOT-SOONER', quantity: 30 }]],
          [102, [{ order_item_id: 102, batch_number: 'LOT-SOONER', quantity: 20 }]]
        ]),
        today: '2026-11-16'
      })
    ).toThrow(/only has 40 available/i);
  });
});

describe('MockZohoAdapter & LiveZohoAdapter batch + invoice forwarding', () => {
  it('MockZohoAdapter serves warehouse-filtered batches and preserves custom SI + batches on invoice & package', async () => {
    const adapter = new MockZohoAdapter();
    const batchRes = await adapter.getItemBatches('Z-ITEM-1');
    expect(batchRes.batches.length).toBeGreaterThanOrEqual(2);

    const createdSo = await adapter.createSalesOrder({
      getmeds_order_id: 'GM-20261116-0099',
      customer_name: 'Hospital Test',
      customer_type: 'credit',
      customer_master_type: 'credit',
      salesperson_name: 'TEST | MEDREP',
      items: [{ sku: 'MER-1G', name: 'Meropenem 1g', quantity: 10, unit_price: 500, subtotal: 5000 }]
    });
    await adapter.confirmSalesOrder(createdSo.salesorder.salesorder_id);
    const { salesorder } = await adapter.getSalesOrder(createdSo.salesorder.salesorder_id);
    const soLineId = salesorder.line_items[0].line_item_id;

    const batchesBySoLineItemId = {
      [soLineId]: [{ batch_id: 'B-1', batch_in_id: 'BI-1', batch_number: 'MOCK-BT-A1', warehouse_id: 'W-MAIN', quantity: 10 }]
    };

    const inv = await adapter.createInvoiceFromSalesOrder(salesorder, {
      invoiceNumber: '2MG-SI000004987',
      doctorName: 'NNH',
      invoicingFrom: '2mg Incorporated',
      batchesBySoLineItemId
    });
    expect(inv.invoice.invoice_number).toBe('2MG-SI000004987');
    expect(inv.invoice.reference_number).toBe(salesorder.salesorder_number);
    expect(inv.invoice.custom_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customfield_id: '2254168001890600049', value: 'NNH' }),
        expect.objectContaining({ customfield_id: '2254168001900812588', value: '2mg Incorporated' })
      ])
    );
    expect(inv.invoice.line_items[0].batches).toHaveLength(1);

    const pkg = await adapter.createPackageForSalesOrder(salesorder, { batchesBySoLineItemId });
    expect(pkg.package.line_items[0].batches).toHaveLength(1);
    expect(pkg.package.line_items[0].warehouse_id).toBe('W-MAIN');
  });

  it('LiveZohoAdapter uses GET /items/batches?item_id= and fixes invoice reference_number + custom fields', async () => {
    const adapter = new LiveZohoAdapter({
      baseUrl: 'https://www.zohoapis.com/inventory/v1',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtok',
      organizationId: '714292728',
      allowedOrgIds: ['714292728'],
      logger: () => {}
    });
    const calls = [];
    adapter.getAccessToken = jest.fn().mockResolvedValue('tok');
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (url.includes('/items/batches')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, batches: [{ batch_number: 'BT-1' }] }) };
      }
      if (url.includes('/invoices')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, invoice: { invoice_id: 'I-1', invoice_number: '2MG-SI000004987' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, package: { package_id: 'P-1' } }) };
    });

    try {
      const bRes = await adapter.getItemBatches('2254168001995576120');
      expect(calls[0].url).toContain('/items/batches?');
      expect(calls[0].url).toContain('item_id=2254168001995576120');
      expect(bRes.batches).toHaveLength(1);

      const salesorder = {
        salesorder_id: 'SO-ID-1',
        salesorder_number: 'SO-70070',
        reference_number: 'GM-20261116-0001',
        customer_id: 'CUST-1',
        line_items: [{ line_item_id: 'SOL-1', item_id: 'ITEM-1', name: 'PazoGet 200mg', rate: 100, quantity: 5, quantity_invoiced: 0, quantity_packed: 0 }]
      };
      await adapter.createInvoiceFromSalesOrder(salesorder, {
        invoiceNumber: '2MG-SI000004987',
        doctorName: 'JAY LAMORENA',
        invoicingFrom: '2mg Incorporated',
        batchesBySoLineItemId: {
          'SOL-1': [{ zoho_batch_id: 'BID-1', zoho_batch_in_id: 'BIN-1', batch_number: 'BT26244A', warehouse_id: 'WH-1', quantity: 5 }]
        }
      });

      const invCall = calls[1];
      expect(invCall.url).toContain('ignore_auto_number_generation=true');
      expect(invCall.body.invoice_number).toBe('2MG-SI000004987');
      expect(invCall.body.template_id).toBe('2254168000013830593');
      expect(invCall.body.reference_number).toBe('SO-70070'); // Critical KPI fix!
      expect(invCall.body.custom_fields).toEqual(
        expect.arrayContaining([
          { customfield_id: '2254168001890600049', value: 'JAY LAMORENA' },
          { customfield_id: '2254168001900812588', value: '2mg Incorporated' }
        ])
      );
      expect(invCall.body.line_items[0]).toMatchObject({
        warehouse_id: 'WH-1',
        batches: [{ batch_id: 'BID-1', batch_in_id: 'BIN-1', batch_number: 'BT26244A', out_quantity: 5, warehouse_id: 'WH-1' }]
      });

      await adapter.createPackageForSalesOrder(salesorder, {
        batchesBySoLineItemId: {
          'SOL-1': [{ zoho_batch_id: 'BID-1', zoho_batch_in_id: 'BIN-1', batch_number: 'BT26244A', warehouse_id: 'WH-1', quantity: 5 }]
        }
      });
      const pkgCall = calls[2];
      expect(pkgCall.body.line_items[0]).toMatchObject({
        so_line_item_id: 'SOL-1',
        warehouse_id: 'WH-1',
        batches: [{ batch_id: 'BID-1', batch_in_id: 'BIN-1', batch_number: 'BT26244A', out_quantity: 5, warehouse_id: 'WH-1' }]
      });

      const invoicedSo = {
        ...salesorder,
        line_items: [{ ...salesorder.line_items[0], is_invoiced: true, quantity_invoiced: 5 }]
      };
      await adapter.createPackageForSalesOrder(invoicedSo, {
        skipBatchesForInvoicedLines: true,
        carrier: 'Grab Express',
        batchesBySoLineItemId: {
          'SOL-1': [{ zoho_batch_id: 'BID-1', batch_number: 'BT26244A', warehouse_id: 'WH-1', quantity: 5 }]
        }
      });
      const pkgInvoicedCall = calls[3];
      expect(pkgInvoicedCall.body.line_items[0].batches).toBeUndefined();
      expect(pkgInvoicedCall.body.custom_fields).toEqual([
        { customfield_id: '2254168000007192994', value: 'Grab' }
      ]);

      await adapter.createShipmentForPackage({
        salesorderId: 'SO-ID-1',
        packageId: 'PKG-1',
        date: '2026-11-19',
        deliveryMethod: 'Lalamove',
        trackingNumber: ''
      });
      const shpCall = calls[4];
      expect(shpCall.url).toContain('/shipmentorders');
      expect(shpCall.body.shipment_number).toBeUndefined();
      expect(shpCall.body.delivery_method).toBe('Lalamove');
      expect(shpCall.body.tracking_number).toBe('');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('extractZohoContactCompliance reads cf_tin and cf_lto_license_number from flat, hash, or custom_fields array', () => {
    const { extractZohoContactCompliance } = require('../src/services/customerTinService');
    expect(extractZohoContactCompliance({
      cf_tin: '009-341-772-000',
      custom_fields: [{ api_name: 'cf_lto_license_number', value: 'LTO-300001884' }]
    })).toEqual({ tin: '009-341-772-000', lto_license_number: 'LTO-300001884' });

    expect(extractZohoContactCompliance({
      custom_field_hash: { cf_tin: '121-786-330', cf_lto_license_number: 'LTO-99' }
    })).toEqual({ tin: '121-786-330', lto_license_number: 'LTO-99' });
  });
});
