/**
 * ZohoAdapter — the ONLY contract the rest of the app is allowed to talk to.
 *
 * Why this exists:
 *   Controllers should never import a Zoho HTTP client, an OAuth token helper,
 *   or a mock directly. They call `require('./integrations/zoho')` (the
 *   factory in index.js) and get back an object shaped like this class.
 *   That means swapping mock <-> sandbox <-> live is a one-line env change,
 *   never a code change, and it means every implementation is forced to
 *   expose the exact same, deliberately small, surface.
 *
 * Safety-by-design (Aug 27, 2026 — tightened to "create-only, read-only
 * inventory/customers" per explicit policy before live-data testing):
 *   There is NO delete, void, bulk-delete, or write-off method on this
 *   contract — on purpose. There is also no longer any method that can
 *   confirm/pack/ship a Sales Order, record a payment, add a comment, or
 *   create/edit/activate a Zoho Item or a Zoho Contact. The ONLY write this
 *   app is allowed to make to Zoho at all is `createSalesOrder` — and that
 *   creates the SO as a plain Draft (Zoho's own default when you don't also
 *   call a separate confirm/submit action), never auto-confirmed. Every
 *   other Zoho-side step (confirming the SO, invoicing, recording payment,
 *   packing, shipping, adjusting stock, creating/editing items or contacts)
 *   is expected to happen directly in Zoho, by a human, not through this
 *   app. Because the interface itself doesn't declare those methods, no
 *   implementation (mock, sandbox, or live) can be called to do them
 *   through this adapter, and no future controller code can accidentally
 *   reach for `zoho.confirmSalesOrder(...)` or `zoho.adjustStock(...)` — it
 *   simply doesn't exist. If a real need for one of those ever comes up,
 *   that should be a deliberate, reviewed addition to this file, not an
 *   ad-hoc call from a controller.
 *
 *   `createSalesOrder` also never looks up or creates a Zoho contact or a
 *   Zoho item on the fly — it requires the caller to already know the
 *   Zoho contact id (`orderData.zoho_customer_id`) and, per line item, the
 *   Zoho item id if one exists (`item.zoho_item_id`). Those ids only ever
 *   come from a read (`listContacts`/`listItems`), never from a write this
 *   adapter performs — see src/controllers/customers.controller.js and
 *   inventory.controller.js's syncPullStock.
 *
 * Every method here mirrors the real Zoho Books/Inventory REST API's
 * request/response shape (see MockZohoAdapter.js and mock-server/ for the
 * exact field names), so code written against the mock needs zero changes
 * to run against the live API later.
 */
class ZohoAdapter {
  /** @returns {string} 'mock' | 'http-mock' | 'live' — for logging/audit only, never branch app logic on this. */
  get mode() {
    throw new Error('ZohoAdapter.mode must be implemented by subclass');
  }

  /**
   * Create a Sales Order. This is the ONLY write this adapter can make to
   * Zoho. It is created as a plain Draft — nothing in this adapter ever
   * confirms it, invoices it, or records payment against it; that happens
   * directly in Zoho by Finance/Dispatch, never through this app.
   *
   * Never creates or looks up a Zoho contact or item — both must already
   * be known and passed in, or the call fails loudly.
   *
   * @param {object} orderData - {getmeds_order_id, customer_name, customer_type,
   *   customer_master_type, total_amount, delivery_address,
   *   zoho_customer_id: string (REQUIRED — an existing Zoho contact id),
   *   items: [{sku, name, quantity, unit_price, subtotal, zoho_item_id?}]}
   * @returns {Promise<{code:number, message:string, salesorder:object}>}
   */
  async createSalesOrder(orderData) {
    throw new Error('Not implemented');
  }

  /** @returns {Promise<{code:number, message:string, salesorder:object}>} */
  async getSalesOrder(salesorderId) {
    throw new Error('Not implemented');
  }

  /** @returns {Promise<{code:number, message:string, salesorders:object[]}>} */
  async listSalesOrders(params = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: list contacts already in Zoho. Used to mirror customers
   * into the local `customers` table (see customers.controller.js) so an
   * order can carry an existing `zoho_customer_id` — this adapter never
   * creates a contact itself.
   * @returns {Promise<{code:number, message:string, contacts:object[]}>}
   */
  async listContacts(params = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: list items already in Zoho Inventory. Used to compare/pull
   * stock into the local `products` table (see inventory.controller.js's
   * syncPullStock) — this adapter never creates, edits, or adjusts a Zoho
   * item or its stock.
   * @returns {Promise<{code:number, message:string, items:object[]}>}
   */
  async listItems(params = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: fetch ONE contact's full detail, including its
   * billing_address — a field Zoho's List Contacts response never carries
   * (see LiveZohoAdapter's implementation comment). Used to auto-fill a
   * customer's delivery address the moment a MedRep selects them on the
   * order form (customers.controller.js's getZohoAddress), rather than
   * fetching every contact's full detail during the bulk sync-from-zoho
   * pull (which would multiply that pull's API calls by however many
   * customers exist, for data most of them will never need in a given
   * session).
   * @returns {Promise<{code:number, message:string, contact:object}>}
   */
  async getContact(contactId) {
    throw new Error('Not implemented');
  }

  /**
   * Toggle a simulated outage, for demoing "Zoho is down" on demand
   * (Test Mode only calls this). Meaningful only for MockZohoAdapter — the
   * base implementation is a no-op so calling this against LiveZohoAdapter
   * (which already fails naturally if the real API is unreachable) never
   * throws or does anything surprising.
   * @param {boolean} enabled
   */
  setSimulatedOutage(enabled) {
    // no-op by default
  }

  /** @returns {boolean} */
  isSimulatedOutage() {
    return false;
  }
}

module.exports = ZohoAdapter;
