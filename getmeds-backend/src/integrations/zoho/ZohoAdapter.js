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
 *   Sep 2, 2026: `listSalespersons` follows the same rule. It exists so the
 *   app can CHECK that a MedRep's Salesperson name is already present in
 *   Zoho before sending an order that names it. There is still no method
 *   that creates one — a missing Salesperson is added by a human, in Zoho.
 *
 *   Sep 8, 2026: `updateContactTin` is a second, deliberate exception to
 *   "createSalesOrder is the ONLY write" above — reviewed and signed off
 *   the same day. Zoho refuses to create a Sales Order for a "business"
 *   sub-type contact with no value in its `cf_tin` (Tax Identification
 *   Number — a Philippines BIR requirement) custom field, and there is no
 *   Sales-Order-level alternative for this org: TIN can only be set on the
 *   contact itself. This method exists to unblock exactly that, and
 *   nothing more — it sends exactly one custom field and can never be used
 *   to touch a contact's name, address, or anything else. It is still not
 *   a general updateContact(): that continues not to exist here, on
 *   purpose. If a real need for a broader contact write ever comes up,
 *   that too should be a deliberate, reviewed addition, not a widening of
 *   this one.
 *
 *   Sep 8, 2026 (2): `addSalesOrderAttachment` is a THIRD deliberate,
 *   reviewed exception, same day, same reasoning. This app already lets
 *   MedRep/Management/Finance attach files to an order locally (Proof of
 *   Payment / Purchase Order / Other — see paymentProof.controller.js);
 *   this pushes a copy of each newly-attached file onto the matching Zoho
 *   Sales Order's own "Attach File(s)" section, so staff working directly
 *   in Zoho see the same files without anyone re-uploading them there by
 *   hand. It is strictly additive: there is no method here that lists,
 *   downloads, replaces, or deletes an existing Zoho attachment — only
 *   adds a new one. Soft-gated at the call site
 *   (paymentProof.controller.js): a failed push never undoes or blocks the
 *   local attachment.
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

  /**
   * Read-only: EVERY Sales Order in the org, walking Zoho's pages until it
   * says there are no more.
   *
   * Sep 9, 2026: `opts` added, identical in shape and meaning to
   * listContacts/listItems below — `opts.onPage(progress)` for live progress
   * reporting, and `opts.sinceWatermark` (+ optional `opts.watermarkField`,
   * default `last_modified_time`) for an incremental "Quick Sync" walk that
   * stops as soon as it reaches a Sales Order it has already seen. Both are
   * additive and default to the previous behaviour (full walk, no callback),
   * so the one existing caller needed no change.
   *
   * @returns {Promise<{code:number, message:string, salesorders:object[], truncated?:boolean, newWatermark?:string, stoppedEarly?:boolean}>}
   */
  async listSalesOrders(params = {}, opts = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: ONE page of Sales Orders, newest first.
   *
   * Sep 1, 2026 (6). listSalesOrders above walks every page until Zoho says
   * there are no more — right for a full mirror, badly wrong for "show me the
   * five most recent", which would otherwise pull the org's entire Sales Order
   * history to then discard all but five. This is the bounded read.
   *
   * @returns {Promise<{code:number, message:string, salesorders:object[]}>}
   */
  async listRecentSalesOrders(limit = 5) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: ONE Sales Order's "Comments & History" — the log Zoho itself
   * keeps of everything that happened to it, each entry carrying who did it
   * (`commented_by`), when (`date`/`time`/`operation_type`) and what
   * (`description`: "Sales Order created", "Status changed from Draft to
   * Confirmed", "Invoice created", ...).
   *
   * Sep 9, 2026. Added for the "retrieve everything from Zoho" import (see
   * services/zohoOrderImportService.js). Everything else in this app's audit
   * trail is INFERRED — reconcileService compares Zoho's current state
   * against the local row and writes a checkpoint for each difference it can
   * see. That reconstructs the milestones, but never the actual history: it
   * cannot say WHEN the Sales Order was confirmed, or by WHOM, only that it
   * is confirmed now. This endpoint is that missing half, straight from
   * Zoho's own record.
   *
   * A plain GET, like every other read here. `addComment` was deliberately
   * removed from this contract on Aug 27, 2026 and this does NOT bring it
   * back — there is still no method anywhere that writes a comment to Zoho.
   *
   * @param {string} salesorderId
   * @returns {Promise<{code:number, message:string, comments:object[]}>}
   */
  async listSalesOrderComments(salesorderId) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: list contacts already in Zoho. Used to mirror customers
   * into the local `customers` table (see customers.controller.js) so an
   * order can carry an existing `zoho_customer_id` — this adapter never
   * creates a contact itself.
   *
   * Aug 28, 2026: `opts` is optional and purely additive (default `{}`) —
   * `opts.onPage(progress)` for live progress reporting, and
   * `opts.sinceWatermark` (+ optional `opts.watermarkField`) to request an
   * incremental "Quick Sync" pull (only records modified after that
   * watermark) instead of the full walk. See LiveZohoAdapter._paginatedList
   * for the concrete behavior; MockZohoAdapter accepts and mostly ignores
   * these given its tiny, static fixture set.
   * @returns {Promise<{code:number, message:string, contacts:object[], truncated?:boolean, newWatermark?:string, stoppedEarly?:boolean}>}
   */
  async listContacts(params = {}, opts = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Read-only: list items already in Zoho Inventory. Used to compare/pull
   * stock into the local `products` table (see inventory.controller.js's
   * syncPullStock) — this adapter never creates, edits, or adjusts a Zoho
   * item or its stock.
   *
   * Aug 28, 2026: see listContacts above — same optional, additive `opts`
   * (onPage / sinceWatermark / watermarkField) for Quick Sync + progress.
   * @returns {Promise<{code:number, message:string, items:object[], truncated?:boolean, newWatermark?:string, stoppedEarly?:boolean}>}
   */
  async listItems(params = {}, opts = {}) {
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
   * Read-only: list the Salespersons configured in the Zoho org.
   *
   * Sep 2, 2026. "Salesperson" is a MANDATORY field on every Sales Order in
   * this org, and `createSalesOrder` sends it by NAME
   * ("<division> | <display name>", from users.salesperson — see the sign-up
   * form). Zoho matches that name against its own list; a name it does not
   * recognise means the Sales Order is rejected. This exists so the app can
   * check the name first and say so on the order form, rather than letting a
   * MedRep fill in a whole order and discover the problem at submit.
   *
   * Read-only, like every other list method here. It is deliberately NOT a
   * create: if a MedRep's Salesperson is missing from Zoho, a human adds it
   * in Zoho. Nothing in this app creates one — same rule as contacts and
   * items.
   * @returns {Promise<{code:number, message:string, salespersons:object[]}>}
   */
  async listSalespersons() {
    throw new Error('Not implemented');
  }

  /**
   * Write EXACTLY ONE thing to an existing Zoho contact: its TIN (`cf_tin`
   * custom field). See the Sep 8, 2026 note above for why this narrow
   * exception exists. Never creates a contact — `contactId` must already
   * exist (from a prior `listContacts`/`getContact` read) — and never sends
   * any field other than `cf_tin`, so it cannot be used to rename a
   * customer, change its address, or touch anything else about it.
   * @param {string} contactId - an existing Zoho contact id
   * @param {string} tin - the TIN value to write
   * @returns {Promise<{code:number, message:string, contact:object}>}
   */
  async updateContactTin(contactId, tin) {
    throw new Error('Not implemented');
  }

  /**
   * Add ONE file attachment to an existing Zoho Sales Order. See the Sep 8,
   * 2026 (2) note above for why this narrow, add-only exception exists.
   * Never lists, downloads, replaces, or deletes an attachment — every
   * call here can only add a new one.
   * @param {string} salesorderId - an existing Zoho Sales Order id
   * @param {{buffer: Buffer, filename: string, contentType?: string}} file
   * @returns {Promise<{code:number, message:string, document:object}>}
   */
  async addSalesOrderAttachment(salesorderId, file) {
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
