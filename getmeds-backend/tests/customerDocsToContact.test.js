/**
 * Nov 26, 2026 — Binakayan Hospital: a customer's BIR 2303 / LTO / permit
 * never reached the customer's own page in Zoho. pushCustomerDocsToContact
 * attaches each one to the Zoho contact, once. Stubbed database, no Postgres.
 */
const mockState = new Map();
const mockDocs = [
  { id: 41, customer_id: 157537, storage_path: 'customers/157537/documents/a.pdf', file_name: '[BIR 2303] BIR 2303_Binakayan.pdf', content_type: 'application/pdf' },
  { id: 42, customer_id: 157537, storage_path: 'customers/157537/documents/b.jfif', file_name: '[LTO PERMIT] IMG.jfif', content_type: 'image/jpeg' },
];
let mockContactId = '2254168002011671387';

jest.mock('../src/db/database', () => ({
  prepare: (sql) => ({
    get: async () => (/FROM customers WHERE id/.test(sql) ? { id: 157537, name: 'Binakayan', zoho_contact_id: mockContactId } : null),
    all: async () => (/FROM customer_documents/.test(sql) ? mockDocs : []),
    run: async () => ({}),
  }),
}));
jest.mock('../src/services/schemaColumns', () => ({ hasColumn: async () => true }));
jest.mock('../src/services/syncState', () => ({
  getSyncState: async (k) => mockState.get(k) || null,
  setSyncState: async (k, v) => { mockState.set(k, v); },
}));
jest.mock('../src/services/paymentProofStorage', () => ({ downloadFile: jest.fn(async () => Buffer.from('bytes')) }));
jest.mock('../src/integrations/zoho', () => ({
  addContactAttachment: jest.fn(async (id, f) => ({ document: { document_id: `D-${f.filename}` } })),
}));

const zoho = require('../src/integrations/zoho');
const { pushCustomerDocsToContact } = require('../src/services/customerDocsZoho');
const { assertZohoCallAllowed } = require('../src/integrations/zoho/zohoWriteLock');

describe('pushCustomerDocsToContact', () => {
  it('attaches every document to the Zoho customer, .jfif sent as .jpg', async () => {
    const r = await pushCustomerDocsToContact(157537);
    expect(r).toEqual({ pushed: 2, failed: 0, skipped: 0 });
    expect(zoho.addContactAttachment.mock.calls.map((c) => [c[0], c[1].filename])).toEqual([
      ['2254168002011671387', '[BIR 2303] BIR 2303_Binakayan.pdf'],
      ['2254168002011671387', '[LTO PERMIT] IMG.jpg'],
    ]);
    expect(mockState.get('customer_doc_zoho:41')).toBe('D-[BIR 2303] BIR 2303_Binakayan.pdf');
  });

  it('never sends the same document twice', async () => {
    zoho.addContactAttachment.mockClear();
    expect(await pushCustomerDocsToContact(157537)).toEqual({ pushed: 0, failed: 0, skipped: 2 });
    expect(zoho.addContactAttachment).not.toHaveBeenCalled();
  });

  it('does nothing for a customer not yet in Zoho', async () => {
    mockContactId = null;
    expect(await pushCustomerDocsToContact(157537)).toEqual({ pushed: 0, failed: 0, skipped: 0 });
    mockContactId = '2254168002011671387';
  });

  it('the Zoho write lock allows the contact attachment call', () => {
    expect(() => assertZohoCallAllowed('POST', '/contacts/2254168002011671387/attachment')).not.toThrow();
  });
});
