/**
 * Sep 14, 2026 — the order's Headquarter reaches Zoho's "Headquarter" field.
 *
 * cf_head_quarter is a plain text custom field on this org's Sales Order,
 * id 2254168002004671156, read from Zoho_Books list_custom_fields
 * (entity=salesorder) the day it was wired. Like Sub-division: free text,
 * optional, and omitted when blank rather than sent empty.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const { buildZohoSalesOrderPayload } = require('../src/services/zohoPayloadBuilder');

const HEADQUARTER_FIELD_ID = '2254168002004671156';

describe('Headquarter on the Sales Order', () => {
  describe('what the live adapter sends', () => {
    // No socket: the request and the salesperson lookup are stubbed, and the
    // body that would have gone to Zoho is read back.
    async function bodyFor(extra) {
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
        getmeds_order_id: 'GM-HQ-0001',
        items: [],
        salesperson_name: 'BID | Someone',
        ...extra
      });
      const [, path, opts] = adapter._request.mock.calls.find(([method]) => method === 'POST');
      expect(path).toBe('/salesorders');
      return opts.body;
    }

    test('sends it as cf_head_quarter', async () => {
      const body = await bodyFor({ headquarter: 'Cebu HQ' });
      expect(body.custom_fields).toContainEqual({ customfield_id: HEADQUARTER_FIELD_ID, value: 'Cebu HQ' });
    });

    test('omits it when blank, rather than sending an empty value', async () => {
      const body = await bodyFor({ headquarter: '' });
      expect((body.custom_fields || []).some((f) => f.customfield_id === HEADQUARTER_FIELD_ID)).toBe(false);
    });
  });

  test('the mock records it, so the rest of the suite can see what would be sent', async () => {
    const res = await new MockZohoAdapter({ log: () => {} }).createSalesOrder({
      getmeds_order_id: 'GM-HQ-0002',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: 'TEST | Aaron Manila',
      headquarter: 'Makati HQ'
    });
    expect(res.salesorder.custom_fields).toContainEqual({ label: 'Headquarter', value: 'Makati HQ' });
  });

  describe('on the order', () => {
    let token;
    let ownerId;
    let customerId;
    const createdOrderIds = [];

    beforeAll(async () => {
      const login = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
      token = login.body.data.token;
      ownerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('medrep@getmeds.ph')).id;
      customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    });

    afterAll(async () => {
      for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });

    async function draftOrder(headquarter = null) {
      const ref = `HQ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                               total_amount, delivery_address, headquarter)
           VALUES (?, ?, ?, 'draft', 'credit', 100, '1 HQ St', ?)`
        )
        .run(ref, customerId, ownerId, headquarter);
      const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
      createdOrderIds.push(id);
      return id;
    }
    const headquarterOf = async (id) => (await db.prepare('SELECT headquarter FROM orders WHERE id = ?').get(id)).headquarter;

    test('can be set, changed and cleared before the order reaches Zoho', async () => {
      const id = await draftOrder();
      const edit = (headquarter) =>
        request(app).patch(`/api/orders/${id}/details`).set({ Authorization: `Bearer ${token}` }).send({ headquarter, delivery_notes: 'hq' });

      expect((await edit('Cebu HQ')).status).toBe(200);
      expect(await headquarterOf(id)).toBe('Cebu HQ');
      expect((await edit('Davao HQ')).status).toBe(200);
      expect(await headquarterOf(id)).toBe('Davao HQ');
      expect((await edit('')).status).toBe(200);
      expect(await headquarterOf(id)).toBeNull();
    });

    test('a retried order sends the Headquarter stored on it', async () => {
      const id = await draftOrder('Iloilo HQ');
      const payload = await buildZohoSalesOrderPayload(id);
      expect(payload.headquarter).toBe('Iloilo HQ');
    });
  });
});
