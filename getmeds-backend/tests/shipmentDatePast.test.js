/**
 * Sep 19, 2026 — Management can create a Sales Order even after the
 * Expected Shipment Date has passed.
 *
 * An order can sit as a draft for days (a customer held for Zoho, an
 * approval waiting on someone) before it's finally raised — by then the
 * date a MedRep picked at intake can be behind today. Sending an expired
 * shipment_date was what blocked the Sales Order from being created at
 * all. Rather than invent a replacement date, LiveZohoAdapter now leaves
 * the field out when it has passed — Zoho's own default applies, same as
 * an order that never had one. What the MedRep originally entered stays
 * exactly as typed in this app's own record; only what reaches Zoho changes.
 */
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');

const YESTERDAY = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // safely in the past
const FAR_FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

describe('Expected Shipment Date in the past no longer blocks the Sales Order', () => {
  describe('what the live adapter sends', () => {
    async function bodyFor(expected_shipment_date) {
      const adapter = new LiveZohoAdapter({
        baseUrl: 'https://zoho.invalid',
        organizationId: 'ORG-1',
        allowedOrgIds: ['ORG-1'],
        log: () => {}
      });
      adapter._resolveSalespersonId = async () => 'SP-1';
      adapter._request = jest.fn(async () => ({ salesorder: { salesorder_id: 'SO-1' } }));
      await adapter.createSalesOrder({
        zoho_customer_id: 'C-1',
        getmeds_order_id: 'GM-SHIP-0001',
        items: [],
        salesperson_name: 'BID | Someone',
        expected_shipment_date
      });
      const [, , opts] = adapter._request.mock.calls.find(([method]) => method === 'POST');
      return opts.body;
    }

    test('a date already behind today is left out — the Sales Order still gets created', async () => {
      const body = await bodyFor(YESTERDAY);
      expect(body.shipment_date).toBeUndefined();
    });

    test("today's own date is still sent", async () => {
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // Manila
      const body = await bodyFor(today);
      expect(body.shipment_date).toBe(today);
    });

    test('a future date is sent exactly as given', async () => {
      const body = await bodyFor(FAR_FUTURE);
      expect(body.shipment_date).toBe(FAR_FUTURE);
    });

    test('no date at all — still nothing sent, unchanged from before', async () => {
      const body = await bodyFor(undefined);
      expect(body.shipment_date).toBeUndefined();
    });
  });

  test('the mock mirrors the same rule, so the rest of the suite can rely on it', async () => {
    const mock = new MockZohoAdapter({ log: () => {} });
    const past = await mock.createSalesOrder({
      getmeds_order_id: 'GM-SHIP-0002',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: 'TEST | Aaron Manila',
      expected_shipment_date: YESTERDAY
    });
    expect(past.salesorder.shipment_date).toBeUndefined();

    const future = await mock.createSalesOrder({
      getmeds_order_id: 'GM-SHIP-0003',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: 'TEST | Aaron Manila',
      expected_shipment_date: FAR_FUTURE
    });
    expect(future.salesorder.shipment_date).toBe(FAR_FUTURE);
  });
});
