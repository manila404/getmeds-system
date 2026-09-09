const ZohoAdapter = require('./ZohoAdapter');
const { findSalesperson, SalespersonNotFoundError } = require('./salespersonName');
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
  constructor({ seedItems = items, seedContacts = contacts, seedSalespersons, log = console.log } = {}) {
    super();
    this._log = log;
    this._items = new Map(seedItems.map((i) => [i.item_id, { ...i }]));
    this._contacts = new Map(seedContacts.map((c) => [c.contact_id, { ...c }]));
    this._salesOrders = new Map();
    this._soCounter = 1;
    this._simulatedOutage = false;
    // Sep 2, 2026: enough of a Salesperson list to exercise both branches of
    // the "does this name exist in Zoho?" check without a network call.
    // Override via seedSalespersons in a test that needs a specific list.
    //
    // Sep 2, 2026 (2): every seeded login is here too, because
    // createSalesOrder now REFUSES a name it cannot resolve to an id (see
    // salespersonName.js). Without these, seeding a database would give you
    // six accounts that cannot place an order — and the mock would be
    // lenient where live is strict, which is the exact divergence that hid
    // the listSalespersons parsing bug.
    this._salespersons =
      seedSalespersons || [
        { salesperson_id: 'MOCK-SP-1', salesperson_name: 'TEST | MEDREP' },
        { salesperson_id: 'MOCK-SP-2', salesperson_name: 'TEST | Aaron Manila' },
        { salesperson_id: 'MOCK-SP-3', salesperson_name: 'NORTH | Juan dela Cruz' },
        { salesperson_id: 'MOCK-SP-4', salesperson_name: 'NORTH | Maria Santos' },
        { salesperson_id: 'MOCK-SP-5', salesperson_name: 'TEST | Admin User' },
        { salesperson_id: 'MOCK-SP-6', salesperson_name: 'TEST | Rosa Reyes' },
        { salesperson_id: 'MOCK-SP-7', salesperson_name: 'TEST | Ben Ramos' },
        { salesperson_id: 'MOCK-SP-8', salesperson_name: 'TEST | Carlo Tan' },
        // orderAsMedrep.test.js's second rep. Here rather than injected,
        // because those tests go through the app's adapter singleton and
        // cannot pass seedSalespersons to it.
        { salesperson_id: 'MOCK-SP-9', salesperson_name: 'NORTH | Bea Cruz' }
      ];
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

    // Mirrors LiveZohoAdapter's salesperson resolution exactly, refusal
    // included: the name is resolved to an id against this mock's own list
    // and an unmatched one throws. Being lenient here would let the suite
    // pass while live orders fail — or worse, while live quietly creates a
    // Salesperson, which is what actually happened before Sep 2.
    const salespersonName = (orderData.salesperson_name || '').trim();
    if (!salespersonName) {
      throw new SalespersonNotFoundError(null);
    }
    const salespersonMatch = findSalesperson(this._salespersons, salespersonName);
    if (!salespersonMatch) {
      throw new SalespersonNotFoundError(salespersonName);
    }

    const salesorder = {
      salesorder_id,
      salesorder_number,
      status: 'draft',
      customer_id: contact.contact_id,
      customer_name: contact.contact_name || orderData.customer_name,
      total: orderData.total_amount,
      reference_number: orderData.getmeds_order_id,
      notes,
      salesperson_id: salespersonMatch.salesperson_id,
      salesperson_name: salespersonMatch.salesperson_name,
      date: new Date().toISOString().slice(0, 10),
      // Sep 9, 2026: mirrors LiveZohoAdapter's shipment_date so a test can
      // assert what would have been sent. Omitted when blank, exactly as
      // there — the mock being lenient where live is strict is the divergence
      // that hid the listSalespersons parsing bug.
      ...(orderData.expected_shipment_date ? { shipment_date: orderData.expected_shipment_date } : {}),
      line_items: (orderData.items || []).map((item) => ({
        item_id: item.zoho_item_id || null,
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price,
        item_total: item.subtotal
      })),
      custom_fields: [
        { label: 'Getmeds Customer Type', value: customerTypeLabel },
        { label: 'Payment Status', value: paymentStatusLabel },
        // Sep 2, 2026: mirrors LiveZohoAdapter's cf_division /
        // cf_sub_division so a test can assert what would have been sent.
        // Omitted entirely when blank, exactly as there.
        ...(orderData.division ? [{ label: 'Division', value: orderData.division }] : []),
        ...(orderData.sub_division ? [{ label: 'Sub-division', value: orderData.sub_division }] : []),
        // Sep 8, 2026 (3): mirrors LiveZohoAdapter's cf_gm_lead_id so a test
        // can assert what would have been sent. Omitted when blank, same
        // convention as every other custom field here.
        ...(orderData.gm_lead_id ? [{ label: 'GM Lead ID', value: orderData.gm_lead_id }] : [])
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

  async listRecentSalesOrders(limit = 5) {
    const all = [...this._salesOrders.values()].reverse();
    return { code: 0, message: 'success', salesorders: all.slice(0, limit) };
  }

  /**
   * Sep 9, 2026: accepts (and mostly ignores) the same `(params, opts)` shape
   * LiveZohoAdapter's paginated walk takes, and returns the same
   * truncated/newWatermark/stoppedEarly keys — same reasoning as
   * listContacts/listItems below. Still calls `opts.onPage` once so an import
   * job started against mock mode reports SOME progress rather than jumping
   * from 0% straight to done.
   */
  async listSalesOrders(params = {}, opts = {}) {
    const salesorders = [...this._salesOrders.values()];
    if (opts.onPage) {
      try { opts.onPage({ processed: salesorders.length, page: 1, hasMorePages: false }); } catch (_) {}
    }
    return { code: 0, message: 'success', salesorders, truncated: false, newWatermark: null, stoppedEarly: false };
  }

  /**
   * Mirrors LiveZohoAdapter.listSalesOrderComments' shape. Read-only, like
   * there — this mock has no addComment either.
   *
   * The fixture set carries no history of its own (a mock Sales Order is
   * created and then never touched again), so this synthesises the ONE entry
   * Zoho would definitely have for any Sales Order that exists: its creation.
   * Enough for the import path's log ingestion to be exercised end to end in
   * mock mode without pretending to a richer history than the mock has.
   */
  async listSalesOrderComments(salesorderId) {
    const salesorder = this._salesOrders.get(salesorderId);
    if (!salesorder) {
      return { code: 4, message: 'The Sales Order ID given seems to be incorrect. [MOCK MODE]', comments: [] };
    }
    return {
      code: 0,
      message: 'success',
      comments: [
        {
          comment_id: `mock-comment-${salesorderId}`,
          salesorder_id: salesorderId,
          description: `Sales Order created for ${salesorder.customer_name || 'customer'}`,
          commented_by: salesorder.salesperson_name || 'Mock User',
          comment_type: 'system',
          operation_type: 'Added',
          date: (salesorder.created_time || new Date().toISOString()).slice(0, 10),
          date_description: 'Mock history entry',
          time: '00:00 AM'
        }
      ]
    };
  }

  // Aug 28, 2026: accepts (and mostly ignores) the same `(params, opts)`
  // shape LiveZohoAdapter's Quick Sync / progress-callback support added —
  // this fixture set is tiny and carries no `last_modified_time` field, so
  // there's no meaningful "since watermark" filtering to do here; mock/dev
  // mode always behaves like a (trivially fast) full pull regardless of
  // requested mode. Still calls `opts.onPage` once so a job started against
  // mock mode reports SOME progress instead of jumping straight from 0% to
  // done with nothing in between.
  async listContacts(params = {}, opts = {}) {
    const contacts = [...this._contacts.values()];
    if (opts.onPage) {
      try { opts.onPage({ processed: contacts.length, page: 1, hasMorePages: false }); } catch (_) {}
    }
    return { code: 0, message: 'success', contacts, truncated: false, newWatermark: null, stoppedEarly: false };
  }

  async listItems(params = {}, opts = {}) {
    const items = [...this._items.values()];
    if (opts.onPage) {
      try { opts.onPage({ processed: items.length, page: 1, hasMorePages: false }); } catch (_) {}
    }
    return { code: 0, message: 'success', items, truncated: false, newWatermark: null, stoppedEarly: false };
  }

  /** Mirrors LiveZohoAdapter.listSalespersons' shape. Read-only, like there. */
  async listSalespersons() {
    return { code: 0, message: 'success', salespersons: [...this._salespersons] };
  }

  /** Mirrors LiveZohoAdapter.getContact's shape — returns the full seeded contact (including billing_address, if the fixture has one). */
  async getContact(contactId) {
    const contact = this._contacts.get(contactId);
    if (!contact) {
      return { code: 4, message: 'The contact ID given seems to be incorrect. [MOCK MODE]' };
    }
    return { code: 0, message: 'success', contact };
  }

  /**
   * Mirrors LiveZohoAdapter.updateContactTin: sets ONLY `cf_tin` on the
   * seeded in-memory contact, nothing else about it. See ZohoAdapter.js's
   * Sep 8, 2026 note for why this narrow write exists.
   */
  async updateContactTin(contactId, tin) {
    if (!contactId) throw new Error('updateContactTin requires a Zoho contact id');
    const value = String(tin || '').trim();
    if (!value) throw new Error('updateContactTin requires a non-empty tin value');

    const contact = this._contacts.get(contactId);
    if (!contact) {
      return { code: 4, message: 'The contact ID given seems to be incorrect. [MOCK MODE]' };
    }
    contact.cf_tin = value;
    this._log(`[ZOHO_MOCK] Would PUT /contacts/${contactId} custom_fields: [{cf_tin: "${value}"}]`);
    return { code: 0, message: 'Contact TIN updated successfully [MOCK MODE]', contact };
  }

  /**
   * Mirrors LiveZohoAdapter.addSalesOrderAttachment: records the file
   * against the seeded in-memory Sales Order, adds nothing else, never
   * touches an existing attachment. See ZohoAdapter.js's Sep 8, 2026 (2)
   * note for why this narrow write exists.
   */
  async addSalesOrderAttachment(salesorderId, file) {
    const salesorder = this._salesOrders.get(salesorderId);
    if (!salesorder) {
      return { code: 4, message: 'The Sales Order ID given seems to be incorrect. [MOCK MODE]' };
    }
    const { filename, contentType, buffer } = file || {};
    if (!buffer || !buffer.length) throw new Error('addSalesOrderAttachment requires non-empty file data');

    const document = {
      document_id: `MOCK-DOC-${this._soCounter}-${(salesorder._attachments || []).length + 1}`,
      file_name: filename || 'attachment',
      file_type: contentType || 'application/octet-stream',
      file_size: buffer.length
    };
    salesorder._attachments = salesorder._attachments || [];
    salesorder._attachments.push(document);
    this._log(`[ZOHO_MOCK] Would POST /salesorders/${salesorderId}/attachment: ${document.file_name}`);
    return { code: 0, message: 'Attachment added successfully [MOCK MODE]', document };
  }
}

module.exports = MockZohoAdapter;
