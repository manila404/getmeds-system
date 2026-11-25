/**
 * Nov 25, 2026 — GM-20261124-0074: a new customer's BIR 2303 / LTO / business
 * permit (customer_documents) never reached Zoho. pushCustomerDocuments sends
 * them onto the Sales Order, once per customer.
 *
 * Unit test on a stubbed database (no Postgres needed).
 */
const events = [];
const DOCS = [
  { id: 17, customer_id: 157506, storage_path: 'customers/157506/documents/a.jpeg', file_name: '[BIR 2303] IMG_5755.jpeg', content_type: 'image/jpeg' },
  { id: 18, customer_id: 157506, storage_path: 'customers/157506/documents/b.jpeg', file_name: '[LTO PERMIT] IMG_5753.jpeg', content_type: 'image/jpeg' },
];

jest.mock('../src/db/database', () => ({
  prepare: (sql) => ({
    get: async () => (/FROM orders WHERE id/.test(sql) ? { id: 64075, customer_id: 157506 } : null),
    all: async () => {
      if (/FROM customer_documents/.test(sql)) return DOCS;
      if (/ZOHO_CUSTOMER_DOCS_ADDED/.test(sql)) return events.map((e) => ({ metadata: JSON.stringify(e.metadata) }));
      return [];
    },
    run: async () => ({}),
  }),
}));
jest.mock('../src/services/schemaColumns', () => ({ hasColumn: async () => true }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async (e) => { events.push(e); }) }));
jest.mock('../src/services/paymentProofStorage', () => ({ downloadFile: jest.fn(async () => Buffer.from('bytes')) }));
jest.mock('../src/integrations/zoho', () => ({ addSalesOrderAttachment: jest.fn(async () => ({ document: { document_id: 'd1' } })) }));

const zoho = require('../src/integrations/zoho');
const { pushCustomerDocuments } = require('../src/services/zohoAttachmentSync');

describe('pushCustomerDocuments', () => {
  it('sends every customer document onto the new Sales Order and records it', async () => {
    const r = await pushCustomerDocuments(64075, 'SO1');
    expect(r).toEqual({ pushed: 2, failed: 0 });
    expect(zoho.addSalesOrderAttachment).toHaveBeenCalledTimes(2);
    expect(zoho.addSalesOrderAttachment.mock.calls[0][1].filename).toBe('[BIR 2303] IMG_5755.jpeg');
    expect(events[0]).toMatchObject({ eventType: 'ZOHO_CUSTOMER_DOCS_ADDED', metadata: { customer_document_ids: [17, 18] } });
  });

  it('does not send the same documents again on the next order', async () => {
    zoho.addSalesOrderAttachment.mockClear();
    const r = await pushCustomerDocuments(64075, 'SO2');
    expect(r).toEqual({ pushed: 0, failed: 0 });
    expect(zoho.addSalesOrderAttachment).not.toHaveBeenCalled();
  });

  it('does nothing without a Sales Order', async () => {
    expect(await pushCustomerDocuments(64075, null)).toEqual({ pushed: 0, failed: 0 });
  });
});
