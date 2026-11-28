const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
const { invoiceFieldsFromSo, invoiceLineFieldsFromSo } = require('../src/integrations/zoho/invoiceFromSalesOrder');

// Trimmed from the live Sales Orders behind the Nov 28, 2026 report.
const so70713 = {
  salesorder_id: '2254168002011794691',
  salesorder_number: 'SO-70713',
  reference_number: 'GM-20261128-0013',
  customer_id: '2254168002005395399',
  salesperson_id: '2254168001901490056',
  status: 'confirmed',
  payment_terms: 15,
  payment_terms_label: 'Net 15',
  is_inclusive_tax: true,
  is_discount_before_tax: true,
  discount_type: 'item_level',
  discount: 0,
  shipping_charge: 0,
  adjustment: 0,
  terms: 'Additional P200 for delivery fee. Please book as PRIORITY',
  notes: 'Order No.: GM-20261128-0013',
  custom_field_hash: { cf_invoicing_from: '2mg Incorporated', cf_doctor_name: 'Marliz Escaño', cf_source: 'Doctor order' },
  line_items: [
    { line_item_id: 'L1', item_id: 'I1', name: 'Anti D 300mcg/ml', rate: 10000, quantity: 1, quantity_invoiced: 0, unit: 'Box', tax_id: '2254168000000078097', warehouse_id: 'W1', discount: 0, description: '' },
    { line_item_id: 'L2', item_id: 'I2', name: 'Packaging', rate: 89, quantity: 1, quantity_invoiced: 0, unit: 'pcs', tax_id: '2254168000000078097', warehouse_id: 'W1', discount: 0 }
  ]
};

function liveAdapterCapturingPosts() {
  const adapter = new LiveZohoAdapter({
    clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok',
    organizationId: '714292728', allowedOrgIds: ['714292728'],
    baseUrl: 'https://www.zohoapis.com/inventory/v1', logger: () => {}
  });
  const posts = [];
  adapter._request = jest.fn(async (method, path, opts) => {
    posts.push({ method, path, ...opts });
    return { message: 'ok', invoice: { invoice_id: 'NEW', invoice_number: 'INV-1', status: 'draft' } };
  });
  return { adapter, posts };
}

describe('Invoice from Sales Order — the invoice says what the SO says', () => {
  it('the live adapter POSTs the SO payment terms, tax preference, line taxes, terms and notes', async () => {
    const { adapter, posts } = liveAdapterCapturingPosts();
    await adapter.createInvoiceFromSalesOrder(so70713, { date: '2026-11-28', invoicingFrom: '2mg Incorporated' });

    expect(posts).toHaveLength(1);
    const { body } = posts[0];
    expect(posts[0]).toMatchObject({ method: 'POST', path: '/invoices' });
    expect(body).toMatchObject({
      customer_id: '2254168002005395399',
      reference_number: 'SO-70713',
      date: '2026-11-28',
      payment_terms: 15,
      payment_terms_label: 'Net 15',
      is_inclusive_tax: true,
      is_discount_before_tax: true,
      discount_type: 'item_level',
      terms: 'Additional P200 for delivery fee. Please book as PRIORITY',
      notes: 'Order No.: GM-20261128-0013',
      template_id: '2254168000013830593',
      salesperson_id: '2254168001901490056'
    });
    expect(body.line_items.map((l) => [l.salesorder_item_id, l.tax_id, l.warehouse_id, l.quantity]))
      .toEqual([['L1', '2254168000000078097', 'W1', 1], ['L2', '2254168000000078097', 'W1', 1]]);
    expect(body).not.toHaveProperty('shipping_charge');
    expect(body).not.toHaveProperty('discount');
  });

  it('Advanced Payment keeps its 0 day count (it came out "net 60" before)', () => {
    const f = invoiceFieldsFromSo({ ...so70713, payment_terms: 0, payment_terms_label: 'Advanced Payment' });
    expect(f.payment_terms).toBe(0);
    expect(f.payment_terms_label).toBe('Advanced Payment');
  });

  it('sends no terms fields when the SO has none, rather than inventing one', () => {
    const { payment_terms, payment_terms_label, is_inclusive_tax, ...bare } = so70713;
    const f = invoiceFieldsFromSo(bare);
    expect(f).not.toHaveProperty('payment_terms');
    expect(f).not.toHaveProperty('payment_terms_label');
    expect(f).not.toHaveProperty('is_inclusive_tax');
  });

  it('line discounts go across; a fixed amount is shared out on a partial invoice', () => {
    expect(invoiceLineFieldsFromSo({ quantity: 10, discount: '10%' }, 10).discount).toBe('10%');
    expect(invoiceLineFieldsFromSo({ quantity: 4, discount: 40 }, 3).discount).toBe(30);
    expect(invoiceLineFieldsFromSo({ quantity: 4, discount: 0 }, 4)).not.toHaveProperty('discount');
  });

  it('order discount, shipping and adjustment go on the first invoice only', () => {
    const so = { ...so70713, discount_type: 'entity_level', discount: '5%', shipping_charge: 200, adjustment: -1.5, adjustment_description: 'Rounding' };
    expect(invoiceFieldsFromSo(so)).toEqual(expect.objectContaining({ discount: '5%', shipping_charge: 200, adjustment: -1.5, adjustment_description: 'Rounding' }));

    const later = invoiceFieldsFromSo({ ...so, line_items: [{ ...so.line_items[0], quantity: 2, quantity_invoiced: 1 }] });
    expect(later).not.toHaveProperty('discount');
    expect(later).not.toHaveProperty('shipping_charge');
    expect(later).not.toHaveProperty('adjustment');
  });

  it('batches picked by Dispatch still decide the line warehouse', async () => {
    const { adapter, posts } = liveAdapterCapturingPosts();
    await adapter.createInvoiceFromSalesOrder(so70713, {
      batchesBySoLineItemId: { L1: [{ batch_number: 'B1', quantity: 1, warehouse_id: 'W1', zoho_batch_id: 'ZB1' }] }
    });
    const l1 = posts[0].body.line_items[0];
    expect(l1.warehouse_id).toBe('W1');
    expect(l1.batches).toEqual([expect.objectContaining({ batch_id: 'ZB1', batch_number: 'B1', out_quantity: 1 })]);
    expect(l1.tax_id).toBe('2254168000000078097');
  });
});
