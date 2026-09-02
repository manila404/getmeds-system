const fs = require('fs');
const path = require('path');
const ZohoAdapter = require('../src/integrations/zoho/ZohoAdapter');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const { _buildAdapterForTest } = require('../src/integrations/zoho');

const sampleOrderData = {
  getmeds_order_id: 'GM-20260821-0001',
  customer_name: 'Juana Dela Cruz (Fixture)',
  customer_type: 'direct',
  customer_master_type: 'direct',
  total_amount: 100,
  delivery_address: '123 Test St',
  // Sep 2, 2026 (2): required now. createSalesOrder refuses an order it
  // cannot resolve to a salesperson_id, so a fixture without one no longer
  // reaches the assertions these tests are actually about.
  salesperson_name: 'TEST | MEDREP',
  items: [{ sku: 'PARA-500-TAB', name: 'Paracetamol 500mg Tablet', quantity: 10, unit_price: 2.25, subtotal: 22.5 }]
};

describe('ZohoAdapter contract — safety by design', () => {
  it('declares no delete/void/remove/destroy/write-off method anywhere on the base contract', () => {
    const methodNames = Object.getOwnPropertyNames(ZohoAdapter.prototype);
    const destructivePattern = /delete|void|remove|destroy|write.?off|purge/i;
    const offenders = methodNames.filter((name) => destructivePattern.test(name));
    expect(offenders).toEqual([]);
  });

  it('base class methods all throw "Not implemented" so a half-built adapter fails loudly, not silently', async () => {
    const base = new (class extends ZohoAdapter {})();
    await expect(base.createSalesOrder({})).rejects.toThrow('Not implemented');
    await expect(base.getSalesOrder('x')).rejects.toThrow('Not implemented');
    await expect(base.listSalesOrders()).rejects.toThrow('Not implemented');
  });
});

describe('MockZohoAdapter', () => {
  it('never performs a network call — module has no fetch/http/https/axios import', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/integrations/zoho/MockZohoAdapter.js'),
      'utf8'
    );
    expect(/require\(['"](https?|axios)['"]\)/.test(src)).toBe(false);
    expect(/\bfetch\(/.test(src)).toBe(false);
  });

  it('creates a sales order in the real Zoho response shape', async () => {
    const adapter = new MockZohoAdapter();
    const result = await adapter.createSalesOrder(sampleOrderData);

    expect(result.code).toBe(0);
    expect(result.salesorder).toMatchObject({
      status: 'draft',
      reference_number: sampleOrderData.getmeds_order_id,
      customer_name: sampleOrderData.customer_name
    });
    expect(result.salesorder.salesorder_id).toMatch(/^MOCK-SO-\d{6}$/);
    expect(result.salesorder.salesorder_number).toMatch(/^SO-\d{5}$/);
    expect(result.salesorder.line_items).toHaveLength(1);
  });

  it('round-trips: created sales orders can be fetched back by id and appear in listSalesOrders', async () => {
    const adapter = new MockZohoAdapter();
    const created = await adapter.createSalesOrder(sampleOrderData);
    const soId = created.salesorder.salesorder_id;

    const fetched = await adapter.getSalesOrder(soId);
    expect(fetched.salesorder.salesorder_id).toBe(soId);

    const listed = await adapter.listSalesOrders();
    expect(listed.salesorders.map((s) => s.salesorder_id)).toContain(soId);
  });

  it('getSalesOrder on an unknown id returns a Zoho-shaped error, not a crash', async () => {
    const adapter = new MockZohoAdapter();
    const result = await adapter.getSalesOrder('NOPE-DOES-NOT-EXIST');
    expect(result.code).not.toBe(0);
  });

  it('setSimulatedOutage(true) makes createSalesOrder reject; disabling it restores normal behavior', async () => {
    const adapter = new MockZohoAdapter();
    expect(adapter.isSimulatedOutage()).toBe(false);

    adapter.setSimulatedOutage(true);
    expect(adapter.isSimulatedOutage()).toBe(true);
    await expect(adapter.createSalesOrder(sampleOrderData)).rejects.toThrow(/[Ss]imulated Zoho.*outage/);

    adapter.setSimulatedOutage(false);
    expect(adapter.isSimulatedOutage()).toBe(false);
    const result = await adapter.createSalesOrder(sampleOrderData);
    expect(result.code).toBe(0);
  });

  it('createSalesOrder requires a REAL Zoho contact when given an explicit zoho_customer_id, and links line items via zoho_item_id only when present', async () => {
    const adapter = new MockZohoAdapter();
    const knownContactId = [...adapter._contacts.keys()][0];
    const result = await adapter.createSalesOrder({
      ...sampleOrderData,
      zoho_customer_id: knownContactId,
      items: [{ ...sampleOrderData.items[0], zoho_item_id: 'MOCK-ITEM-KNOWN' }]
    });
    expect(result.salesorder.customer_id).toBe(knownContactId);
    expect(result.salesorder.line_items[0].item_id).toBe('MOCK-ITEM-KNOWN');
  });
});

describe('ZohoAdapter contract — create-only, no confirm/pack/ship/payment/contact-write/item-write', () => {
  it('the trimmed contract no longer declares findOrCreateContact, adjustStock, confirmSalesOrder, packSalesOrder, shipSalesOrder, addOrderComment, recordPaymentForSalesOrder, createItem, findOrCreateItem, or activateItem', () => {
    const methodNames = Object.getOwnPropertyNames(ZohoAdapter.prototype);
    const removedMethods = [
      'findOrCreateContact', 'adjustStock', 'confirmSalesOrder', 'packSalesOrder',
      'shipSalesOrder', 'addOrderComment', 'recordPaymentForSalesOrder', 'createItem',
      'findOrCreateItem', 'activateItem'
    ];
    for (const m of removedMethods) {
      expect(methodNames).not.toContain(m);
    }
  });
});

describe('ZohoAdapter base class — simulated-outage no-op default', () => {
  it('setSimulatedOutage/isSimulatedOutage are safe no-ops unless overridden (e.g. by LiveZohoAdapter)', () => {
    const base = new (class extends ZohoAdapter {})();
    expect(() => base.setSimulatedOutage(true)).not.toThrow();
    expect(base.isSimulatedOutage()).toBe(false);
  });
});

describe('Zoho adapter factory — fail-closed guardrails', () => {
  it('defaults to mock mode when ZOHO_MODE is unset', () => {
    const adapter = _buildAdapterForTest({});
    expect(adapter.mode).toBe('mock');
  });

  it('falls back to mock mode on an unrecognized ZOHO_MODE value', () => {
    const adapter = _buildAdapterForTest({ ZOHO_MODE: 'production-please' });
    expect(adapter.mode).toBe('mock');
  });

  it('http-mock mode never requires or contacts a real org id', () => {
    const adapter = _buildAdapterForTest({ ZOHO_MODE: 'http-mock' });
    expect(adapter.mode).toBe('http-mock');
  });

  it('refuses to build a live adapter with no ZOHO_ORG_ID set', () => {
    expect(() => _buildAdapterForTest({ ZOHO_MODE: 'live' })).toThrow(/ZOHO_ORG_ID/);
  });

  it('refuses to build a live adapter with no allowlist set, even with an org id present', () => {
    expect(() =>
      _buildAdapterForTest({ ZOHO_MODE: 'live', ZOHO_ORG_ID: '999999999' })
    ).toThrow(/ZOHO_ALLOWED_ORG_IDS/);
  });

  it('refuses to build a live adapter whose org id is not in the allowlist', () => {
    expect(() =>
      _buildAdapterForTest({
        ZOHO_MODE: 'live',
        ZOHO_ORG_ID: '999999999',
        ZOHO_ALLOWED_ORG_IDS: '111111111,222222222'
      })
    ).toThrow(/not in ZOHO_ALLOWED_ORG_IDS/);
  });

  it('builds a live adapter successfully once its org id is explicitly allowlisted', () => {
    const adapter = _buildAdapterForTest({
      ZOHO_MODE: 'live',
      ZOHO_ORG_ID: '999999999',
      ZOHO_ALLOWED_ORG_IDS: '999999999'
    });
    expect(adapter.mode).toBe('live');
    // Note: constructing the adapter never makes a network call — only
    // calling one of its methods (createSalesOrder, etc.) would, and this
    // test deliberately does not do that.
  });
});
