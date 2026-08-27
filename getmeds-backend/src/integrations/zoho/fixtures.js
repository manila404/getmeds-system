/**
 * Shared fixture data for the mock adapter (in-process) and the mock HTTP
 * server (mock-server/). Both consume this same file so the two "fake Zoho"
 * surfaces never drift apart. Field names match the real Zoho
 * Books/Inventory API (see: ZohoInventory_create_item, _create_sales_order,
 * _list_items, _list_sales_orders in the connected Zoho MCP tool schemas).
 *
 * Every ID here is obviously fake (ITEM-FIX-*, CONTACT-FIX-*) so a stray
 * write can never be mistaken for having hit a real record.
 */

const FIXED_ORG_ID = '000000000000001'; // the fake test-org id used by the mock

const items = [
  {
    item_id: 'ITEM-FIX-0001',
    name: 'Amoxicillin 500mg Capsule',
    sku: 'AMOX-500-CAP',
    rate: 8.5,
    purchase_rate: 5.75,
    unit: 'pcs',
    item_type: 'sales_and_purchases',
    description: 'Broad-spectrum antibiotic, 500mg capsule',
    status: 'active'
  },
  {
    item_id: 'ITEM-FIX-0002',
    name: 'Paracetamol 500mg Tablet',
    sku: 'PARA-500-TAB',
    rate: 2.25,
    purchase_rate: 1.1,
    unit: 'pcs',
    item_type: 'sales_and_purchases',
    description: 'Analgesic / antipyretic, 500mg tablet',
    status: 'active'
  },
  {
    item_id: 'ITEM-FIX-0003',
    name: 'Losartan 50mg Tablet',
    sku: 'LOSA-50-TAB',
    rate: 12.0,
    purchase_rate: 8.4,
    unit: 'pcs',
    item_type: 'sales_and_purchases',
    description: 'Antihypertensive, 50mg tablet',
    status: 'active'
  }
];

const contacts = [
  {
    contact_id: 'CONTACT-FIX-1001',
    contact_name: 'St. Luke Medical Center (Fixture)',
    company_name: 'St. Luke Medical Center (Fixture)',
    contact_type: 'customer',
    customer_sub_type: 'business',
    getmeds_customer_type: 'credit',
    phone: '028-8555-1234',
    // Aug 27, 2026: Zoho's List Contacts response never includes
    // billing_address (only the single "Get a Contact" detail call does —
    // see LiveZohoAdapter.getContact) — this fixture carries it so the
    // mock/http-mock path can exercise the same detail-fetch-on-select flow
    // a real org needs.
    billing_address: { address: '279 E Rodriguez Sr. Ave', city: 'Quezon City', state: 'Metro Manila', zip: '1102', country: 'Philippines' }
  },
  {
    contact_id: 'CONTACT-FIX-1002',
    contact_name: 'Juana Dela Cruz (Fixture)',
    company_name: '',
    contact_type: 'customer',
    customer_sub_type: 'individual',
    getmeds_customer_type: 'direct',
    mobile: '09171234567',
    billing_address: { address: 'Unit 402, Greenhills Tower', city: 'San Juan', state: 'Metro Manila', zip: '1500', country: 'Philippines' }
  }
];

/** One realistic sample sales order, in the exact shape Zoho returns it. */
const sampleSalesOrder = {
  salesorder_id: 'SO-FIX-00001',
  salesorder_number: 'SO-00001',
  customer_id: contacts[0].contact_id,
  customer_name: contacts[0].contact_name,
  date: '2026-08-21',
  status: 'draft',
  reference_number: 'GM-20260821-0001',
  total: 170.0,
  line_items: [
    {
      item_id: items[0].item_id,
      name: items[0].name,
      quantity: 20,
      rate: items[0].rate,
      item_total: 170.0
    }
  ],
  custom_fields: [
    { label: 'Getmeds Customer Type', value: 'Credit Customer' },
    { label: 'Payment Status', value: 'Credit Terms (Auto-approved)' }
  ],
  created_time: '2026-08-21T00:00:00+08:00'
};

module.exports = { FIXED_ORG_ID, items, contacts, sampleSalesOrder };
