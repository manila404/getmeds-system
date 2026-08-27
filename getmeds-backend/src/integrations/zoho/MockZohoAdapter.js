const ZohoAdapter = require('./ZohoAdapter');
const { items, contacts } = require('./fixtures');

/**
 * MockZohoAdapter — pure in-memory, zero network calls, zero external
 * dependency. This is the default and the safest possible mode: it is
 * physically incapable of touching any real Zoho organization because it
 * never opens a socket.
 *
 * Mirrors the trimmed, create-only/read-only ZohoAdapter contract (Aug 27,
 * 2026): no confirm/pack/ship/payment/comment, no item or contact write.
 * `createSalesOrder` prefers an already-known `zoho_customer_id` /
 * `zoho_item_id`, matching LiveZohoAdapter's strict behavior — but, unlike
 * Live, falls back to a deterministic mock contact/item when one isn't
 * given, so existing local/dev/demo flows (and fixtures/tests) that never
 * bothered to pre-map a customer keep working without touching anything
 * that resembles a real Zoho write.
 *
 * Behavior mirrors the real Zoho Books/Inventory API response shape so
 * that controller code written against this adapter needs no changes to
 * run against LiveZohoAdapter later. Deterministic IDs (a counter, not
 * Date.now()/Math.random()) so tests and demo recordings are reproducible
 * run to run.
 */
class MockZohoAdapter extends ZohoAdapter {
  constructor({ seedItems = items, seedContacts = contacts, log = console.log } = {}) {
    super();
    this._log = log;
    this._items = new Map(seedItems.map((i) => [i.item_id, { ...i }]));
    this._contacts = new Map(seedContacts.map((c) => [c.contact_id, { ...c }]));
    this._salesOrders = new Map();
    this._soCounter = 1;
    this._simulatedOutage = false;
  }

  get mode() {
    return 'mock';
  }

  /** Test Mode uses this to demo "Zoho is down" without touching any network. */
  setSimulatedOutage(enabled) {
    this._simulatedOutage = !!enabled;
    this._log(`[ZOHO_MOCK] Simulated outage ${this._simulatedOutage ? 'ENABLED — createSalesOrder will reject' : 'disabled'}`);
  }

  isSimulatedOutage() {
    return !!this._simulatedOutage;
  }

  _nextSalesOrderId() {
    const n = this._soCounter++;
    return {
      salesorder_id: `MOCK-SO-${String(n).padStart(6, '0')}`,
      salesorder_number: `SO-${String(n).padStart(5, '0')}`
    };
  }

  /**
   * Create a sales order — the only write this class performs, matching
   * LiveZohoAdapter. Prefers `orderData.zoho_customer_id` (an id already
   * present in `this._contacts`, mirroring a real pre-synced mapping); if
   * none is given, this MOCK-ONLY fallback fabricates a placeholder
   * contact rather than rejecting, so dev/demo flows and existing tests
   * that don't pre-map a customer keep working. LiveZohoAdapter has no
   * equivalent fallback — there, a missing zoho_customer_id is a hard
   * failure.
   */
  async createSalesOrder(orderData) {
    if (this._simulatedOutage) {
      throw new Error('Simulated Zoho API outage (Test Mode) — createSalesOrder rejected on purpose.');
    }

    let contact = orderData.zoho_customer_id ? this._contacts.get(orderData.zoho_customer_id) : null;
    if (!contact) {
      contact = {
        contact_id: orderData.zoho_customer_id || `MOCK-CONTACT-${orderData.customer_name || 'unknown'}`,
        contact_name: orderData.customer_name || 'Unknown Customer'
      };
    }

    const { salesorder_id, salesorder_number } = this._nextSalesOrderId();
    const isCredit =
      orderData.customer_type === 'credit' || orderData.customer_master_type === 'credit';
    const customerTypeLabel = isCredit ? 'Credit Customer' : 'Non-Credit Patient';
    const paymentStatusLabel = isCredit
      ? 'Credit Terms (Auto-approved)'
      : 'Pending Finance Verification';

    // Mirrors LiveZohoAdapter's TestGM- notes-prefixing exactly, so the
    // mock's response shape stays a faithful stand-in — see that file for
    // why this exists.
    const isTestOrder = /^TestGM-/i.test(orderData.getmeds_order_id || '');
    const notes = isTestOrder
      ? `TEST — DO NOT FULFILL. Getmeds Order: ${orderData.getmeds_order_id}`
      : `Getmeds Order: ${orderData.getmeds_order_id}`;

    // Mirrors the real request body shape (organization_id + auth would be
    // added by LiveZohoAdapter; here we just log what *would* be sent).
    this._log('[ZOHO_MOCK] Would POST /inventory/v1/salesorders:', {
      customer_id: contact.contact_id,
      reference_number: orderData.getmeds_order_id,
      line_items: (orderData.items || []).map((i) => ({ sku: i.sku, quantity: i.quantity }))
    });

    const salesorder = {
      salesorder_id,
      salesorder_number,
      status: 'draft',
      customer_id: contact.contact_id,
      customer_name: contact.contact_name || orderData.customer_name,
      total: orderData.total_amount,
      reference_number: orderData.getmeds_order_id,
      notes,
      date: new Date().toISOString().slice(0, 10),
      line_items: (orderData.items || []).map((item) => ({
        item_id: item.zoho_item_id || null,
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price,
        item_total: item.subtotal
      })),
      custom_fields: [
        { label: 'Getmeds Customer Type', value: customerTypeLabel },
        { label: 'Payment Status', value: paymentStatusLabel }
      ],
      created_time: new Date().toISOString(),
      _mock: true
    };

    this._salesOrders.set(salesorder_id, salesorder);
    return { code: 0, message: 'Sales order created successfully [MOCK MODE]', salesorder };
  }

  async getSalesOrder(salesorderId) {
    const salesorder = this._salesOrders.get(salesorderId);
    if (!salesorder) {
      return { code: 4, message: `The Sales Order ID given seems to be incorrect. [MOCK MODE]` };
    }
    return { code: 0, message: 'success', salesorder };
  }

  async listSalesOrders() {
    return { code: 0, message: 'success', salesorders: [...this._salesOrders.values()] };
  }

  async listContacts() {
    return { code: 0, message: 'success', contacts: [...this._contacts.values()] };
  }

  async listItems() {
    return { code: 0, message: 'success', items: [...this._items.values()] };
  }

  /** Mirrors LiveZohoAdapter.getContact's shape — returns the full seeded contact (including billing_address, if the fixture has one). */
  async getContact(contactId) {
    const contact = this._contacts.get(contactId);
    if (!contact) {
      return { code: 4, message: 'The contact ID given seems to be incorrect. [MOCK MODE]' };
    }
    return { code: 0, message: 'success', contact };
  }
}

module.exports = MockZohoAdapter;
