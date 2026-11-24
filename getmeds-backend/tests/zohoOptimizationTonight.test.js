'use strict';

const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
const zohoQuotaGuard = require('../src/services/zohoQuotaGuard');
const autoSync = require('../src/services/zohoAutoSyncService');
const zohoReconcileService = require('../src/services/zohoReconcileService');
const zohoSplitReconcileService = require('../src/services/zohoSplitReconcileService');
const zohoRetryService = require('../src/services/zohoRetryService');
const zohoInvoiceCopy = require('../src/services/zohoInvoiceCopy');
const zohoSalespersonSync = require('../src/services/zohoSalespersonSync');
const cronController = require('../src/controllers/cron.controller');

async function cleanQuotaAndOrders() {
  zohoQuotaGuard._resetForTest();
  await db.prepare("DELETE FROM sync_state WHERE key IN ('zoho_daily_limit:state', 'zoho_salesperson_sync:last_run', 'zoho_invoice_copy:last_reconcile_ymd')").run();
  await db.prepare("DELETE FROM sync_state WHERE key LIKE 'zoho_api_calls:%'").run();
}

describe('Zoho API Optimization & Quota Guard (Nov 24 hardening)', () => {
  let medrep;
  let customer;
  const createdOrderIds = [];

  const makeOrder = async ({ ref, status = 'ready_for_draft_invoice', soId = 'ZSO-OPT-1', soNum = 'SO-90001', lastReconciled = null, invoicingFrom = 'Getmeds Philippines Inc.' }) => {
    const existing = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    if (existing) {
      await db.prepare('DELETE FROM delivery_receipt_items WHERE delivery_receipt_id IN (SELECT id FROM delivery_receipts WHERE order_id = ?)').run(existing.id);
      await db.prepare('DELETE FROM delivery_receipts WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM order_split_sales_orders WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    const r = await db.prepare(`
      INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
        total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status, last_reconciled_at, invoicing_from)
      VALUES (?, ?, ?, ?, 'direct', 500, 'Manila', ?, ?, 'synced', ?, ?)
    `).run(ref, customer.id, medrep.id, status, soId, soNum, lastReconciled, invoicingFrom);
    createdOrderIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  beforeAll(async () => {
    medrep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    customer = await db.prepare("SELECT id FROM customers WHERE type = 'direct' LIMIT 1").get();
  });

  beforeEach(cleanQuotaAndOrders);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM delivery_receipt_items WHERE delivery_receipt_id IN (SELECT id FROM delivery_receipts WHERE order_id = ?)').run(id);
      await db.prepare('DELETE FROM delivery_receipts WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_split_sales_orders WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await cleanQuotaAndOrders();
    autoSync.stop();
  });

  test('zohoQuotaGuard persists daily limit across cache reset and tracks usage snapshot', async () => {
    await zohoQuotaGuard.tripDailyLimit('10,000 limit exhausted', 60_000);
    zohoQuotaGuard._resetForTest(); // simulate container restart / cold cache
    const st = await zohoQuotaGuard.getDailyLimitStatus();
    expect(st.limited).toBe(true);
    expect(st.reason).toContain('10,000');

    zohoQuotaGuard.recordCall();
    zohoQuotaGuard.recordCall();
    const snap = await zohoQuotaGuard.getUsageSnapshot();
    expect(snap.callsToday).toBeGreaterThanOrEqual(2);
    expect(snap.limited).toBe(true);

    await zohoQuotaGuard.clearDailyLimit();
    const afterClear = await zohoQuotaGuard.getDailyLimitStatus();
    expect(afterClear.limited).toBe(false);
  });

  test('LiveZohoAdapter coalesces identical concurrent GET requests into 1 HTTP call', async () => {
    const adapter = new LiveZohoAdapter({
      baseUrl: 'https://www.zohoapis.com/inventory/v1',
      organizationId: '714292728',
      allowedOrgIds: ['714292728'],
      getAccessToken: async () => 'tok',
      log: () => {}
    });

    const origFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = jest.fn(async () => {
      fetchCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, batches: [{ batch_number: 'B1' }] })
      };
    });

    try {
      const [a, b, c] = await Promise.all([
        adapter.getItemBatches('ITEM-COALESCE-1'),
        adapter.getItemBatches('ITEM-COALESCE-1'),
        adapter.getItemBatches('ITEM-COALESCE-1')
      ]);
      expect(fetchCalls).toBe(1);
      expect(a.batches[0].batch_number).toBe('B1');
      expect(b.batches[0].batch_number).toBe('B1');
      expect(c.batches[0].batch_number).toBe('B1');
    } finally {
      global.fetch = origFetch;
    }
  });

  test('reconcileOrderFully calls zoho.getSalesOrder ONCE across multi-stage catch-up passes', async () => {
    const id = await makeOrder({ ref: 'OPT-SINGLE-FETCH', status: 'so_created', soId: 'ZSO-SINGLE-1' });
    const getSpy = jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
      code: 0,
      salesorder: {
        salesorder_id: 'ZSO-SINGLE-1',
        salesorder_number: 'SO-90011',
        status: 'confirmed',
        invoices: [{ invoice_id: 'INV-11', invoice_number: 'GPI-SI00011', status: 'sent', total: 500, balance: 500, date: '2026-11-24' }],
        packages: []
      }
    });

    const out = await zohoReconcileService.reconcileOrderFully({ orderId: id, source: 'test' });
    expect(out.ok).toBe(true);
    expect(out.actions.length).toBeGreaterThanOrEqual(2);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  test('zohoAutoSyncService tiers tracking_shared and gates salesperson refresh to 4h', async () => {
    const freshTracking = await makeOrder({
      ref: 'OPT-TRACK-FRESH',
      status: 'tracking_shared',
      soId: 'ZSO-TF',
      lastReconciled: new Date().toISOString()
    });
    const staleTracking = await makeOrder({
      ref: 'OPT-TRACK-STALE',
      status: 'tracking_shared',
      soId: 'ZSO-TS',
      lastReconciled: '2026-11-24T00:00:00.000Z'
    });
    const activeOrder = await makeOrder({
      ref: 'OPT-ACTIVE-1',
      status: 'so_created',
      soId: 'ZSO-ACT',
      lastReconciled: '2026-11-24T12:00:00.000Z' // newer than staleTracking, still higher priority!
    });

    const batch = (await autoSync.pickBatch(200)).map((o) => o.id);
    expect(batch).not.toContain(freshTracking);
    expect(batch).toContain(staleTracking);
    expect(batch).toContain(activeOrder);
    expect(batch.indexOf(activeOrder)).toBeLessThan(batch.indexOf(staleTracking));

    // Gate salesperson refresh: first run refreshes, second immediate run skips it.
    const spSpy = jest.spyOn(zohoSalespersonSync, 'refresh').mockResolvedValue({ added: 0 });
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ code: 0, salesorder: { salesorder_id: 'ZSO-ACT', status: 'draft' } });
    await autoSync.runOnce({ limit: 1 });
    await autoSync.runOnce({ limit: 1 });
    expect(spSpy).toHaveBeenCalledTimes(1);
  });

  test('zohoRetryService respects shared daily limit circuit when force=false and auto-reconciles adopted SO', async () => {
    const orderId = await makeOrder({
      ref: 'OPT-ADOPT-1',
      status: 'so_created',
      soId: null,
      soNum: 'SO-70999'
    });
    await db.prepare("UPDATE orders SET zoho_sync_status = 'failed' WHERE id = ?").run(orderId);
    await zohoRetryService.enqueue({
      orderId,
      payload: { getmeds_order_id: 'OPT-ADOPT-1', items: [] },
      error: 'rate limit'
    });

    await zohoQuotaGuard.tripDailyLimit('10,000 cap', 60_000);
    const blocked = await zohoRetryService.processQueue({ force: false });
    expect(blocked).toEqual([]);

    const findSpy = jest.spyOn(zoho, 'findSalesOrdersByReference').mockResolvedValue({
      salesorders: [{
        salesorder_id: 'ZSO-ADOPTED-99',
        salesorder_number: 'SO-70999',
        reference_number: 'OPT-ADOPT-1',
        status: 'confirmed',
        invoices: [],
        packages: []
      }]
    });
    const getSpy = jest.spyOn(zoho, 'getSalesOrder');

    const res = await zohoRetryService.processQueue({ force: true });
    expect(res.find((r) => r.orderId === orderId)?.outcome).toBe('succeeded');
    expect(findSpy).toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled(); // passed adoptedSo directly into reconcileOrderFully!

    const updated = await db.prepare('SELECT zoho_so_id, status, zoho_sync_status FROM orders WHERE id = ?').get(orderId);
    expect(updated.zoho_so_id).toBe('ZSO-ADOPTED-99');
    expect(updated.zoho_sync_status).toBe('synced');
    expect(updated.status).toBe('ready_for_finance_verified');
  });

  test('cron.controller.autoSync gates zohoInvoiceCopy.reconcile() to once per Manila day', async () => {
    const origSyncEnv = process.env.ZOHO_INVOICE_COPY_SYNC;
    const origAutoEnv = process.env.ZOHO_AUTO_SYNC_ENABLED;
    const origSecret = process.env.CRON_SECRET;
    process.env.ZOHO_INVOICE_COPY_SYNC = 'true';
    process.env.ZOHO_AUTO_SYNC_ENABLED = 'false';
    process.env.CRON_SECRET = 'test-secret';

    // Simulate today already reconciled or past 02:00 PHT: write yesterday first to force one run if hour >= 2,
    // or verify double call never runs reconcile twice on the same Manila day.
    const reconcileSpy = jest.spyOn(zohoInvoiceCopy, 'reconcile').mockResolvedValue({ ok: true });
    jest.spyOn(require('../src/services/stockHoldService'), 'remindDue').mockResolvedValue({ checked: 0 });
    await zohoQuotaGuard.writeState('zoho_invoice_copy:last_reconcile_ymd', zohoQuotaGuard.manilaYmd());

    const makeRes = () => {
      const r = { statusCode: 200, body: null };
      r.status = (c) => { r.statusCode = c; return r; };
      r.json = (b) => { r.body = b; return r; };
      return r;
    };

    try {
      const req = { headers: { authorization: 'Bearer test-secret' }, query: {} };
      const res = makeRes();
      await cronController.autoSync(req, res, jest.fn());
      expect(res.statusCode).toBe(200);
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(res.body.data.retention.invoice_copy_reconcile).toContain('already reconciled today');
    } finally {
      process.env.ZOHO_INVOICE_COPY_SYNC = origSyncEnv;
      process.env.ZOHO_AUTO_SYNC_ENABLED = origAutoEnv;
      process.env.CRON_SECRET = origSecret;
    }
  });

  test('zohoSplitReconcileService backfills PENDING SI delivery_receipts when split invoice arrives', async () => {
    const orderId = await makeOrder({ ref: 'OPT-SPLIT-SI', status: 'ready_for_dispatch', soId: 'ZSO-MAIN', invoicingFrom: '2mg Incorporated' });
    await db.prepare(`
      INSERT INTO order_split_sales_orders (order_id, invoicing_from, zoho_so_id, zoho_so_number, zoho_sync_status, zoho_so_status)
      VALUES (?, 'Getmeds Philippines Inc.', 'ZSO-SPLIT-1', 'SO-90055', 'synced', 'confirmed')
    `).run(orderId);
    const drRes = await db.prepare(`
      INSERT INTO delivery_receipts (dr_number, order_id, entity_key, reference_type, status, si_number, date_issued, customer_name, delivery_address, created_at, updated_at)
      VALUES (4999, ?, 'GPI', 'sales_order', 'issued', NULL, '2026-11-24', 'FIXTURE Customer', 'Manila', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')
    `).run(orderId);
    await db.prepare(`
      INSERT INTO delivery_receipt_items (delivery_receipt_id, entity_key, item_seq_no, item_name, quantity, si_or_to_no, created_at)
      VALUES (?, 'GPI', 1, 'Med A', 10, 'PENDING SI', '2026-11-24T00:00:00Z')
    `).run(drRes.lastInsertRowid);

    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
      code: 0,
      salesorder: {
        salesorder_id: 'ZSO-SPLIT-1',
        salesorder_number: 'SO-90055',
        status: 'confirmed',
        line_items: [],
        invoices: [{ invoice_id: 'INV-SPLIT-1', invoice_number: 'GPI-SI00055', status: 'sent' }],
        packages: []
      }
    });

    await zohoSplitReconcileService.reconcileSplitOrders({ orderId, source: 'test' });
    const dr = await db.prepare('SELECT si_number FROM delivery_receipts WHERE id = ?').get(drRes.lastInsertRowid);
    const dri = await db.prepare('SELECT si_or_to_no FROM delivery_receipt_items WHERE delivery_receipt_id = ?').get(drRes.lastInsertRowid);
    expect(dr.si_number).toBe('GPI-SI00055');
    expect(dri.si_or_to_no).toBe('GPI-SI00055');
  });
});
