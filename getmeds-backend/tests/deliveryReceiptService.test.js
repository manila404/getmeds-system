'use strict';

const ExcelJS = require('exceljs');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const {
  PRINTABLE_ROWS_PER_PAGE,
  chunkPrintableRows,
  summarizeLineBatches,
  buildBatchesBySoLineItemId
} = require('../src/services/deliveryReceiptService');

describe('Printable DR pagination & B1T1 batch mapping helpers', () => {
  it('chunks printable DR items into pages of max 11 rows', () => {
    expect(PRINTABLE_ROWS_PER_PAGE).toBe(11);
    expect(chunkPrintableRows([]).length).toBe(1);
    expect(chunkPrintableRows(Array(11).fill({})).map((p) => p.length)).toEqual([11]);
    expect(chunkPrintableRows(Array(12).fill({})).map((p) => p.length)).toEqual([11, 1]);
    expect(chunkPrintableRows(Array(25).fill({})).map((p) => p.length)).toEqual([11, 11, 3]);
  });

  it('summarizes single and split batches accurately', () => {
    expect(summarizeLineBatches([])).toEqual({ batchNumber: null, expiryDate: null, description: '' });
    expect(summarizeLineBatches([{ batch_number: 'BT-1', expiry_date: '2027-06-30', quantity: 50 }])).toEqual({
      batchNumber: 'BT-1',
      expiryDate: '2027-06-30',
      description: 'Batch: BT-1 | Exp. Date: 2027-06-30'
    });
    const split = summarizeLineBatches([
      { batch_number: 'BT-A', expiry_date: '2027-02-28', quantity: 80 },
      { batch_number: 'BT-B', expiry_date: '2027-09-30', quantity: 40 }
    ]);
    expect(split.batchNumber).toBe('BT-A, BT-B');
    expect(split.description).toContain('BT-A (80, Exp 2027-02-28)');
    expect(split.description).toContain('BT-B (40, Exp 2027-09-30)');
  });

  it('maps B1T1 duplicate-product lines deterministically by SO line item', () => {
    const orderItems = [
      { id: 101, zoho_item_id: 'Z-10', product_name: 'Med A', quantity: 5 },
      { id: 102, zoho_item_id: 'Z-10', product_name: 'Med A', quantity: 5 }
    ];
    const batches = [
      { order_item_id: 101, batch_number: 'PAID-BATCH', quantity: 5 },
      { order_item_id: 102, batch_number: 'PROMO-BATCH', quantity: 5 }
    ];
    const soLines = [
      { line_item_id: 'SO-L1', item_id: 'Z-10', name: 'Med A', quantity: 5 },
      { line_item_id: 'SO-L2', item_id: 'Z-10', name: 'Med A', quantity: 5 }
    ];
    const mapped = buildBatchesBySoLineItemId(orderItems, batches, soLines);
    expect(mapped['SO-L1'][0].batch_number).toBe('PAID-BATCH');
    expect(mapped['SO-L2'][0].batch_number).toBe('PROMO-BATCH');
  });
});

describe('deliveryReceiptService end-to-end flows (mocked DB + MockZohoAdapter)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('issues entity-isolated DR with signatory, updates ledger Excel export (Row 1 DR# / Row 2 blank), and voids cleanly', async () => {
    jest.resetModules();
    const seqState = { '2MG': { last_dr_no: 4902, last_item_no: 1334 }, GPI: { last_dr_no: 4550, last_item_no: 672 } };
    const drs = [];
    const drItems = [];
    const ordersUpdate = [];

    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 10 }, currentCaterer: { actor_id: 1 } })
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: () => ({ id: 1, name: 'Aaron Dispatch' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async (...args) => {
          if (/FROM orders o/i.test(sql)) {
            return {
              id: 10, getmeds_order_id: 'GM-20261114-0015', status: 'ready_for_dispatch',
              invoicing_from: '2mg Incorporated', zoho_so_number: 'SO-88318',
              customer_name: 'GENECCCA PHARMACY', delivery_address: '95-E Maginhawa QC',
              customer_tin: '009-341-772-000', customer_lto: 'FDA-LTO-300001884',
              intake_payment_terms: '30', dispatch_doctor_name: 'NNH'
            };
          }
          if (/FROM delivery_receipts\s+WHERE order_id = \? AND entity_key = \?/i.test(sql)) {
            return drs.find((d) => d.order_id === args[0] && d.entity_key === args[1] && d.status !== 'void') || null;
          }
          if (/FROM dr_sequences WHERE entity_key/i.test(sql)) {
            return seqState[args[0]];
          }
          if (/FROM delivery_receipts WHERE id = \?/i.test(sql)) {
            return drs.find((d) => d.id === Number(args[0])) || null;
          }
          if (/SELECT COUNT\(\*\) AS total/i.test(sql)) {
            return { total: drItems.length };
          }
          return null;
        }),
        all: jest.fn(async (...args) => {
          if (/FROM order_items oi/i.test(sql)) {
            return [
              { id: 1, product_id: 51, product_name: 'Ondansetron 8mg/4mL', quantity: 120, unit: 'AMPS', invoicing_from: null },
              { id: 2, product_id: 52, product_name: 'Omeprazole 40mg IV', quantity: 50, unit: 'VIALS', invoicing_from: null },
              { id: 3, product_id: 53, product_name: 'Split GPI Item', quantity: 10, unit: 'BOX', invoicing_from: 'Getmeds Philippines Inc.' }
            ];
          }
          if (/FROM order_item_batches/i.test(sql)) {
            return [{ id: 1, order_item_id: 1, batch_number: 'OND-24A', expiry_date: '2027-02-28', quantity: 120 }];
          }
          if (/FROM delivery_receipt_items WHERE delivery_receipt_id/i.test(sql)) {
            return drItems.filter((x) => x.delivery_receipt_id === Number(args[0]));
          }
          if (/FROM delivery_receipts dr/i.test(sql)) {
            return drItems.map((it) => {
              const d = drs.find((x) => x.id === it.delivery_receipt_id);
              return {
                dr_id: d.id, entity_key: d.entity_key, dr_number: d.dr_number, reference_type: d.reference_type,
                date_issued: d.date_issued, customer_name: d.customer_name, delivery_address: d.delivery_address,
                tin: d.tin, terms: d.terms, status: d.status,
                item_seq_no: it.item_seq_no, si_or_to_no: it.si_or_to_no, item_name: it.item_name,
                batch_number: it.batch_number, expiry_date: it.expiry_date, quantity: it.quantity, unit: it.unit
              };
            });
          }
          if (/FROM dr_sequences/i.test(sql)) {
            return Object.entries(seqState).map(([entity_key, v]) => ({ entity_key, ...v }));
          }
          return [];
        }),
        run: jest.fn(async (...args) => {
          if (/UPDATE dr_sequences/i.test(sql)) {
            seqState[args[3]] = { last_dr_no: args[0], last_item_no: args[1] };
            return { changes: 1 };
          }
          if (/INSERT INTO delivery_receipts/i.test(sql)) {
            const id = drs.length + 1;
            drs.push({
              id, entity_key: args[0], dr_number: args[1], reference_type: 'sales_order',
              order_id: args[2], external_ref: args[3], si_number: args[4], date_issued: args[5],
              customer_name: args[6], delivery_address: args[7], tin: args[8], lto_license_number: args[9],
              terms: args[10], doctor_name: args[11], status: 'issued', issued_by_name: args[14]
            });
            return { lastInsertRowid: id, changes: 1 };
          }
          if (/INSERT INTO delivery_receipt_items/i.test(sql)) {
            drItems.push({
              id: drItems.length + 1,
              delivery_receipt_id: args[0], entity_key: args[1], order_item_id: args[2],
              item_seq_no: args[3], si_or_to_no: args[4], product_id: args[5],
              item_name: args[6], batch_number: args[7], expiry_date: args[8],
              quantity: args[11], unit: args[12]
            });
            return { changes: 1 };
          }
          if (/UPDATE delivery_receipts/i.test(sql) && /status = 'void'/i.test(sql)) {
            const d = drs.find((x) => x.id === Number(args[4]));
            if (d) { d.status = 'void'; d.void_reason = args[0]; }
            return { changes: 1 };
          }
          if (/UPDATE orders/i.test(sql)) {
            ordersUpdate.push({ sql, args });
          }
          return { changes: 1 };
        })
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const printable = await svc.issueSalesOrderDr({ orderId: 10, entityKey: '2MG', user: { id: 1, name: 'Aaron Dispatch' } });

    expect(printable.receipt.dr_number).toBe(4903);
    expect(printable.receipt.entity_key).toBe('2MG');
    expect(printable.items).toHaveLength(2); // Split GPI item was strictly excluded!
    expect(printable.items.map((x) => x.item_seq_no)).toEqual([1335, 1336]);
    expect(printable.signatory.disclaimer).toBe('"THIS DOCUMENTS IS NOT VALID FOR CLAIM OF INPUT TAX"');

    // Second issue for same order + entity returns 409 DR_ALREADY_EXISTS
    await expect(svc.issueSalesOrderDr({ orderId: 10, entityKey: '2MG', user: { id: 1, name: 'Aaron Dispatch' } }))
      .rejects.toMatchObject({ status: 409, code: 'DR_ALREADY_EXISTS' });

    // Excel export mirrors Row 1 populated DR No. and Row 2 blank DR No.
    const buf = await svc.exportLedgerXlsx({ entityKey: '2MG' });
    const FreshExcel = require('exceljs');
    const wb = new FreshExcel.Workbook();
    await wb.xlsx.load(Buffer.from(buf));
    const ws = wb.getWorksheet('SUMMARY');
    expect(ws.getRow(2).getCell(3).value).toBe(4903); // Row 1 of DR
    expect(ws.getRow(3).getCell(3).value).toBe('');   // Row 2 blank DR No.!

    // Void with switchToNoSi updates order flags cleanly
    const voided = await svc.voidDeliveryReceipt({
      drId: printable.receipt.id,
      user: { id: 1, name: 'Aaron Dispatch' },
      reason: 'Customer switched to standard patient No-SI',
      switchToNoSi: true
    });
    expect(voided.receipt.status).toBe('void');
    expect(ordersUpdate.some((u) => /requires_si = 0/i.test(u.sql))).toBe(true);
  });

  it('finalizeZohoInvoiceForOrder bridges Oojeema SI + batches into Zoho and stamps ledger SI#', async () => {
    jest.resetModules();
    const adapter = new MockZohoAdapter();
    const createdSo = await adapter.createSalesOrder({
      getmeds_order_id: 'GM-20261114-0015',
      customer_name: 'GENECCCA PHARMACY',
      customer_type: 'credit',
      customer_master_type: 'credit',
      salesperson_name: 'TEST | MEDREP',
      items: [{ sku: 'OND-8', name: 'Ondansetron 8mg/4mL', quantity: 10, unit_price: 50, subtotal: 500 }]
    });
    await adapter.confirmSalesOrder(createdSo.salesorder.salesorder_id);

    const dbWrites = [];
    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 20 } })
    }));
    jest.doMock('../src/services/orderClaimService', () => ({
      claimOrder: jest.fn().mockResolvedValue('claim-tok'),
      releaseClaim: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: () => ({ id: 1, name: 'Aaron Dispatch' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => {
          if (/FROM orders o/i.test(sql)) {
            return {
              id: 20, getmeds_order_id: 'GM-20261114-0015', status: 'ready_for_draft_invoice',
              invoicing_from: '2mg Incorporated', zoho_so_id: createdSo.salesorder.salesorder_id,
              customer_category: 'distributor', intake_source: 'Distributor order'
            };
          }
          if (/FROM delivery_receipts/i.test(sql)) {
            return { id: 5, entity_key: '2MG', dr_number: 4903, status: 'issued' };
          }
          return null;
        }),
        all: jest.fn(async () => {
          if (/FROM order_items oi/i.test(sql)) {
            return [{ id: 1, product_name: 'Ondansetron 8mg/4mL', quantity: 10, invoicing_from: null }];
          }
          if (/FROM order_item_batches/i.test(sql)) {
            return [{ id: 1, order_item_id: 1, batch_number: 'OND-24A', warehouse_id: 'W-MAIN', quantity: 10 }];
          }
          return [];
        }),
        run: jest.fn(async (...args) => {
          dbWrites.push({ sql, args });
          return { changes: 1 };
        })
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const res = await svc.finalizeZohoInvoiceForOrder({
      orderId: 20,
      entityKey: '2MG',
      siSuffix: 'SI000004987',
      doctorName: 'NNH',
      user: { id: 1, name: 'Aaron Dispatch' },
      adapter
    });

    expect(res).toMatchObject({
      entity_key: '2MG',
      zoho_invoice_number: '2MG-SI000004987',
      dr_number: 4903
    });
    expect(dbWrites.some((w) => /UPDATE delivery_receipts SET si_number/i.test(w.sql) && w.args[0] === 'SI000004987')).toBe(true);
    expect(dbWrites.some((w) => /UPDATE delivery_receipt_items SET si_or_to_no/i.test(w.sql) && w.args[0] === 'SI000004987')).toBe(true);
  });

  it('finalizeZohoInvoiceForOrder re-hydrates missing mock SO through zoho facade (Doctor/No-SI flow)', async () => {
    jest.resetModules();
    process.env.ZOHO_MODE = 'mock';
    const zohoFacade = require('../src/integrations/zoho');
    zohoFacade._resetForTest();

    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 5 } })
    }));
    jest.doMock('../src/services/orderClaimService', () => ({
      claimOrder: jest.fn().mockResolvedValue('claim-tok'),
      releaseClaim: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: () => ({ id: 5, name: 'Ben Ramos' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => {
          if (/FROM orders o/i.test(sql)) {
            return {
              id: 5, getmeds_order_id: 'GM-20261116-0001', status: 'ready_for_dispatch',
              invoicing_from: '2mg Incorporated', zoho_so_id: 'MOCK-SO-SIM-0001',
              zoho_so_number: 'SO-88410', customer_id: 5, total_amount: 10089,
              customer_category: 'doctor', intake_is_doctor: 1, intake_source: 'Doctor order'
            };
          }
          return null;
        }),
        all: jest.fn(async () => {
          if (/FROM order_items oi/i.test(sql)) {
            return [{ id: 6, product_name: 'Atorvastatin 20mg Tablet', zoho_item_id: 'MOCK-ITEM-ATO', quantity: 90, unit_price: 112.10, invoicing_from: null }];
          }
          if (/FROM order_item_batches/i.test(sql)) {
            return [{ id: 2, order_item_id: 6, batch_number: 'MOCK-BT-B2', warehouse_id: 'W-MAIN', quantity: 90 }];
          }
          return [];
        }),
        run: jest.fn(async () => ({ changes: 1 }))
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const res = await svc.finalizeZohoInvoiceForOrder({
      orderId: 5,
      entityKey: '2MG',
      siSuffix: null,
      doctorName: 'NNH',
      user: { id: 5, name: 'Ben Ramos' },
      adapter: zohoFacade
    });

    expect(res).toMatchObject({
      entity_key: '2MG',
      dr_number: null
    });
    expect(res.zoho_invoice_number).toBeTruthy();
    expect(res.order_updated_at).toBeTruthy();
  });

  it('shipInvoicedOrderInZoho creates Zoho package + shipment with Mode of Delivery and updates dispatch_records', async () => {
    jest.resetModules();
    const adapter = new MockZohoAdapter();
    const createdSo = await adapter.createSalesOrder({
      getmeds_order_id: 'GM-20261119-0020',
      customer_name: 'South City Hospital',
      customer_type: 'credit',
      customer_master_type: 'credit',
      salesperson_name: 'TEST | MEDREP',
      items: [{ sku: 'SUGA-200', name: 'SugamaGet 200mg', quantity: 10, unit_price: 5152, subtotal: 51520 }]
    });
    await adapter.confirmSalesOrder(createdSo.salesorder.salesorder_id);
    const { salesorder } = await adapter.getSalesOrder(createdSo.salesorder.salesorder_id);
    await adapter.createInvoiceFromSalesOrder(salesorder, { invoiceNumber: 'GPI-SI000003094' });

    const writes = [];
    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 30 }, currentCaterer: null })
    }));
    jest.doMock('../src/services/orderClaimService', () => ({
      claimOrder: jest.fn().mockResolvedValue('claim-tok'),
      releaseClaim: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/orderCompletionService', () => ({
      evaluateCompletion: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: () => ({ id: 1, name: 'Aaron Dispatch' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => {
          if (/FROM orders o/i.test(sql)) {
            return {
              id: 30,
              getmeds_order_id: 'GM-20261119-0020',
              status: 'ready_for_dispatch',
              invoicing_from: 'Getmeds Philippines Inc.',
              oojeema_entity: 'GPI',
              intake_delivery_method: 'Lalamove',
              zoho_so_id: createdSo.salesorder.salesorder_id,
              zoho_so_number: createdSo.salesorder.salesorder_number,
              dispatch_id: null
            };
          }
          return null;
        }),
        all: jest.fn(async () => {
          if (/FROM order_items oi/i.test(sql)) {
            return [{ id: 1, product_name: 'SugamaGet 200mg', zoho_item_id: null, quantity: 10, invoicing_from: null }];
          }
          return [];
        }),
        run: jest.fn(async (...args) => {
          writes.push({ sql, args });
          return { changes: 1 };
        })
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const shipped = await svc.shipInvoicedOrderInZoho({
      orderId: 30,
      user: { id: 1, name: 'Aaron Dispatch' },
      adapter
    });

    expect(shipped).toMatchObject({
      entity_key: 'GPI',
      delivery_method: 'Lalamove',
      status: 'dispatched',
      adopted_package: false,
      adopted_shipment: false
    });
    expect(shipped.zoho_package_number).toBeTruthy();
    expect(shipped.zoho_shipment_number).toBeTruthy();
    expect(shipped.order_updated_at).toBeTruthy();
    expect(writes.some((w) => /INSERT INTO dispatch_records/i.test(w.sql))).toBe(true);
    expect(writes.some((w) => /UPDATE orders SET status = \?, updated_at = \?/i.test(w.sql) && w.args[0] === 'dispatched')).toBe(true);
  });

  it('shipInvoicedOrderInZoho enforces tracking for couriers when requireTracking=true and exempts Customer Pick-up / Inhouse', async () => {
    jest.resetModules();
    const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
    const adapter = new MockZohoAdapter();
    adapter._nextSeq = 55;
    const createdSo = await adapter.createSalesOrder({
      getmeds_order_id: 'GM-20261120-0030',
      customer_name: 'South City Hospital',
      customer_type: 'credit',
      customer_master_type: 'credit',
      salesperson_name: 'TEST | MEDREP',
      items: [{ sku: 'SUGA-200', name: 'SugamaGet 200mg', quantity: 5, unit_price: 100 }]
    });
    await adapter.confirmSalesOrder(createdSo.salesorder.salesorder_id);

    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 31 }, currentCaterer: null })
    }));
    jest.doMock('../src/services/orderClaimService', () => ({
      claimOrder: jest.fn().mockResolvedValue('claim-tok'),
      releaseClaim: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/orderCompletionService', () => ({
      evaluateCompletion: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: () => ({ id: 1, name: 'Aaron Dispatch' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => (/FROM orders o/i.test(sql) ? {
          id: 31,
          getmeds_order_id: 'GM-20261120-0030',
          status: 'ready_for_dispatch',
          invoicing_from: 'Getmeds Philippines Inc.',
          oojeema_entity: 'GPI',
          intake_delivery_method: 'LBC Express',
          zoho_so_id: createdSo.salesorder.salesorder_id,
          zoho_so_number: createdSo.salesorder.salesorder_number,
          dispatch_id: null
        } : null)),
        all: jest.fn(async () => (/FROM order_items oi/i.test(sql)
          ? [{ id: 1, product_name: 'SugamaGet 200mg', zoho_item_id: null, quantity: 5, invoicing_from: null }]
          : [])),
        run: jest.fn(async () => ({ changes: 1 }))
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    expect(svc.normalizeZohoDeliveryMethod('Own Rider / Company Vehicle')).toBe('Inhouse');
    expect(svc.normalizeZohoDeliveryMethod('Office Pickup')).toBe('Customer Pick-up');
    expect(svc.isTrackingExemptDeliveryMethod('Customer Pick-up')).toBe(true);
    expect(svc.isTrackingExemptDeliveryMethod('Inhouse')).toBe(true);
    expect(svc.isTrackingExemptDeliveryMethod('Lalamove')).toBe(false);

    await expect(
      svc.shipInvoicedOrderInZoho({
        orderId: 31,
        deliveryMethod: 'LBC Express',
        trackingNumber: '',
        requireTracking: true,
        user: { id: 1, name: 'Aaron Dispatch' },
        adapter
      })
    ).rejects.toMatchObject({ code: 'TRACKING_REQUIRED', status: 422 });

    const pickupShipped = await svc.shipInvoicedOrderInZoho({
      orderId: 31,
      deliveryMethod: 'Office Pickup',
      trackingNumber: '',
      requireTracking: true,
      user: { id: 1, name: 'Aaron Dispatch' },
      adapter
    });
    expect(pickupShipped.delivery_method).toBe('Customer Pick-up');
    expect(pickupShipped.tracking_number).toBeNull();

    const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
    expect(LiveZohoAdapter.prototype._mapPackageCarrier('Customer Pick-up')).toBe('Inhouse');
    expect(LiveZohoAdapter.prototype._mapPackageCarrier('Own Rider / Company Vehicle')).toBe('Inhouse');

    // Lalamove >= 100 char share URL stays < 100 in tracking_number while full link moves to notes
    const longLalamove = `https://share.lalamove.com/?PH100250915114525123456789&lang=en_PH&sign=${'x'.repeat(120)}`;
    const fmt = LiveZohoAdapter.prototype._formatTrackingForZoho(longLalamove);
    expect(fmt.trackingNumber).toBe('PH100250915114525123456789');
    expect(fmt.trackingNumber.length).toBeLessThan(100);
    expect(fmt.notes).toBe(`Tracking link: ${longLalamove}`);
  });

  it('listZohoTransferOrders filters excluded warehouses and expands Zoho TO lines & batches cleanly', async () => {
    jest.resetModules();
    const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
    const adapter = new MockZohoAdapter();

    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn()
    }));
    jest.doMock('../src/services/orderClaimService', () => ({ claimOrder: jest.fn(), releaseClaim: jest.fn() }));
    jest.doMock('../src/services/orderCompletionService', () => ({ evaluateCompletion: jest.fn() }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: async (u) => ({ id: u?.id || 1, name: u?.name || 'Aaron Dispatch' }),
      logEvent: jest.fn()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => null),
        all: jest.fn(async () => {
          if (/FROM products/i.test(sql)) {
            return [{ id: 77, name: 'Palonosetron 50mcg (Paloget)', sku: 'GM-4497', unit: 'Vials', zoho_item_id: 'MOCK-ITEM-P1' }];
          }
          return [];
        }),
        run: jest.fn(async () => ({ changes: 1 }))
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const listRes = await svc.listZohoTransferOrders({ adapter });
    expect(listRes.transfer_orders.map((t) => t.transfer_order_number)).toEqual(['TO-00379']);
    expect(listRes.transfer_orders[0].default_address).toBe('DAVAO CITY');

    const detailRes = await svc.getZohoTransferOrderForDr({ transferOrderId: 'MOCK-TO-379', adapter });
    expect(detailRes.items).toEqual([
      expect.objectContaining({
        product_id: 77,
        item_name: 'Palonosetron 50mcg (Paloget)',
        batch_number: 'M2507479',
        expiry_date: '2028-07-31',
        quantity: 144
      })
    ]);

    await expect(svc.getZohoTransferOrderForDr({ transferOrderId: 'MOCK-TO-EXP', adapter })).rejects.toMatchObject({
      code: 'EXCLUDED_WAREHOUSE',
      status: 422
    });
  });

  it('auto-confirms a Finance-verified draft Zoho SO during finalizeZohoInvoiceForOrder and stamps 2MG invoice template', async () => {
    jest.resetModules();
    const adapter = new MockZohoAdapter();
    const createdSo = await adapter.createSalesOrder({
      getmeds_order_id: 'GM-20261121-0001',
      customer_name: 'Patient Two',
      customer_type: 'patient',
      customer_master_type: 'patient',
      invoicing_from: '2mg Incorporated',
      salesperson_name: 'TEST | MEDREP',
      items: [{ sku: 'SKU-1', name: 'Med 1', quantity: 5, unit_price: 100, subtotal: 500 }]
    });
    const draftSoId = createdSo.salesorder.salesorder_id; // remains draft until confirmed!

    jest.doMock('../src/services/schemaColumns', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../src/services/orderClaimService', () => ({
      claimOrder: jest.fn().mockResolvedValue('tok-1'),
      releaseClaim: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/services/dispatchBatchService', () => ({
      DispatchBatchError: class extends Error { constructor(s, c, m) { super(m); this.status = s; this.code = c; } },
      assertCanActOnOrder: jest.fn().mockResolvedValue({ order: { id: 88 }, currentCaterer: { actor_id: 1 } })
    }));
    jest.doMock('../src/services/auditService', () => ({
      resolveActor: jest.fn().mockResolvedValue({ id: 1, name: 'Aaron Dispatch' }),
      logEvent: jest.fn().mockResolvedValue()
    }));
    jest.doMock('../src/db/database', () => ({
      transaction: jest.fn((fn) => async (...a) => fn(...a)),
      prepare: jest.fn((sql) => ({
        get: jest.fn(async () => {
          if (/FROM orders o/i.test(sql)) {
            return {
              id: 88, getmeds_order_id: 'GM-20261121-0001', status: 'ready_for_draft_invoice',
              invoicing_from: '2mg Incorporated', zoho_so_id: draftSoId, zoho_so_number: createdSo.salesorder.salesorder_number,
              customer_name: 'Patient Two', customer_type: 'patient', intake_doctor: 'NNH'
            };
          }
          if (/FROM order_events/i.test(sql)) return { ok: 1 };
          return null;
        }),
        all: jest.fn(async (/* sql */) => {
          if (/FROM order_items/i.test(sql)) {
            return [{ id: 1, product_id: 10, product_name: 'Med 1', quantity: 5, invoicing_from: null }];
          }
          return [];
        }),
        run: jest.fn(async () => ({ changes: 1 }))
      }))
    }));

    const svc = require('../src/services/deliveryReceiptService');
    const out = await svc.finalizeZohoInvoiceForOrder({
      orderId: 88,
      user: { id: 1, name: 'Aaron Dispatch' },
      entityKey: '2MG',
      requiresSi: false,
      doctorName: 'NNH',
      adapter
    });

    expect(out.entity_key).toBe('2MG');
    const invRes = await adapter.getSalesOrder(draftSoId);
    expect(invRes.salesorder.status).toBe('confirmed');
    expect(invRes.salesorder.invoices[0].invoice_number).toBe(out.zoho_invoice_number);

    // Reject invoicing under a different company when no split SO exists for that entity.
    await expect(
      svc.finalizeZohoInvoiceForOrder({
        orderId: 88,
        user: { id: 1, name: 'Aaron Dispatch' },
        entityKey: 'GPI',
        requiresSi: false,
        doctorName: 'NNH',
        adapter
      })
    ).rejects.toMatchObject({ code: 'ENTITY_MISMATCH', status: 422 });
  });
});
