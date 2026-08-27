const ZohoAdapter = require('./ZohoAdapter');

/**
 * LiveZohoAdapter — makes real HTTP calls, using the built-in global
 * `fetch` (Node 18+, no new dependency added to package.json).
 *
 * "Live" is a loaded word here on purpose: this class doesn't know or care
 * whether `baseUrl` points at the real Zoho API, an isolated test/sandbox
 * Zoho organization, or the local mock-server/ in this same repo — it just
 * makes the HTTP calls the ZohoAdapter contract promises. That's what lets
 * the SAME code path be exercised safely in "http-mock" mode (baseUrl =
 * http://127.0.0.1:4100, a fake org) and later, deliberately, in a real
 * mode (baseUrl = https://www.zohoapis.com/inventory/v1, a real org) —
 * see index.js for how mode selects baseUrl and org id.
 *
 * Guardrails baked into this class (in addition to the factory's checks in
 * index.js, so there's no single point of failure):
 *  - organizationId is validated against `allowedOrgIds` on every single
 *    call, not just at construction — a config that mutates at runtime
 *    can't silently widen scope.
 *  - No delete/void/write-off methods exist here at all (see ZohoAdapter.js
 *    for why) — there is no code path in this class that can issue a
 *    destructive Zoho call.
 *  - As of Aug 27, 2026, this class ALSO has no confirm/pack/ship/payment/
 *    comment/item-write/contact-write method — `createSalesOrder` is the
 *    only request this class ever POSTs to Zoho. It requires the caller to
 *    already know the Zoho contact id (`zoho_customer_id`) and, per line
 *    item, the Zoho item id if one exists (`zoho_item_id`) — this class
 *    never searches for or creates either. An order for a customer that
 *    isn't already mapped to a Zoho contact fails loudly instead of
 *    silently creating one.
 *  - Every outbound request is logged (method, path, org id) before it is
 *    sent, satisfying the project's audit-trail requirement independently
 *    of whatever the caller logs.
 */
class LiveZohoAdapter extends ZohoAdapter {
  constructor({
    baseUrl,
    organizationId,
    allowedOrgIds,
    getAccessToken,
    modeLabel = 'live',
    log = console.log
  }) {
    super();
    if (!baseUrl) throw new Error('LiveZohoAdapter requires baseUrl');
    if (!organizationId) throw new Error('LiveZohoAdapter requires organizationId');
    if (!Array.isArray(allowedOrgIds) || allowedOrgIds.length === 0) {
      throw new Error('LiveZohoAdapter requires a non-empty allowedOrgIds allowlist');
    }
    if (!allowedOrgIds.includes(organizationId)) {
      throw new Error(
        `Refusing to construct LiveZohoAdapter: organization_id "${organizationId}" is not in ` +
          `ZOHO_ALLOWED_ORG_IDS (${allowedOrgIds.join(', ')}). This is a fail-closed safety check — ` +
          `add the org id to the allowlist only after you've confirmed it is the intended test/sandbox org.`
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.organizationId = organizationId;
    this.allowedOrgIds = allowedOrgIds;
    this.getAccessToken = getAccessToken || (async () => {
      throw new Error(
        'No getAccessToken() provided to LiveZohoAdapter — set ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN ' +
          'and wire up OAuth token refresh before using live mode.'
      );
    });
    this._modeLabel = modeLabel;
    this._log = log;
  }

  get mode() {
    return this._modeLabel;
  }

  _assertOrgAllowed() {
    if (!this.allowedOrgIds.includes(this.organizationId)) {
      throw new Error(`organization_id "${this.organizationId}" is no longer in the allowlist — aborting call.`);
    }
  }

  async _request(method, path, { query = {}, body } = {}) {
    this._assertOrgAllowed();
    const params = new URLSearchParams({ organization_id: this.organizationId, ...query });
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    this._log(`[ZOHO_${this._modeLabel.toUpperCase()}] ${method} ${path} (org=${this.organizationId})`);

    const token = await this.getAccessToken();
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(json.message || `Zoho API error (HTTP ${resp.status})`);
      err.zohoResponse = json;
      err.httpStatus = resp.status;
      throw err;
    }
    return json;
  }

  /**
   * Create a Sales Order in Zoho — the only write this class ever performs.
   * Requires an already-known Zoho contact id (`orderData.zoho_customer_id`)
   * — this class never calls GET/POST /contacts to look one up or create
   * one. Line items that already carry a `zoho_item_id` (populated only by
   * a prior read via listItems, never by a write) are linked to that Zoho
   * item; an unmapped line item is still sent (name/rate/quantity), just
   * without an `item_id`, rather than silently creating a Zoho item for it.
   * No confirm/submit call follows — the SO is left exactly as Zoho's API
   * creates it, which is Draft status.
   */
  async createSalesOrder(orderData) {
    const contactId = orderData.zoho_customer_id;
    if (!contactId) {
      throw new Error(
        'createSalesOrder requires an existing Zoho contact id (zoho_customer_id) — this adapter never ' +
          'creates or searches for Zoho contacts. Sync customers from Zoho first (customers.controller.js) ' +
          'and only submit orders for a customer that is already mapped to a Zoho contact.'
      );
    }

    const lineItems = (orderData.items || []).map((item) => {
      const li = {
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price ?? item.rate ?? item.price ?? 0
      };
      // item_id is included ONLY when the local product is already mapped
      // to a Zoho item (populated exclusively by the read-only inventory
      // pull — see inventory.controller.js's syncPullStock). This class
      // never creates, edits, or activates a Zoho item, so an unmapped
      // product is sent as a plain named line rather than auto-created.
      if (item.zoho_item_id) li.item_id = item.zoho_item_id;
      return li;
    });

    // A TestGM- prefixed id (see orderIdService.js) means this order was
    // created while the single-TEST-customer safety gate was on — i.e. a
    // deliberate live test against the real company Zoho org. Flag it as
    // unmistakably as possible in the one place every Finance/Dispatch
    // person looks: the Sales Order's own notes, not just its reference
    // number, so nobody confirms/packs/ships it thinking it's real.
    const isTestOrder = /^TestGM-/i.test(orderData.getmeds_order_id || '');
    const notes = isTestOrder
      ? `TEST — DO NOT FULFILL. Getmeds Order: ${orderData.getmeds_order_id}`
      : `Getmeds Order: ${orderData.getmeds_order_id}`;

    const body = {
      customer_id: contactId,
      date: new Date().toISOString().slice(0, 10),
      reference_number: orderData.getmeds_order_id,
      notes,
      line_items: lineItems
    };

    const result = await this._request('POST', '/salesorders', { body });
    return { code: 0, message: 'Sales order created successfully', salesorder: result.salesorder };
  }

  async getSalesOrder(salesorderId) {
    const result = await this._request('GET', `/salesorders/${salesorderId}`);
    return { code: 0, message: 'success', salesorder: result.salesorder };
  }

  async listSalesOrders(params = {}) {
    const result = await this._request('GET', '/salesorders', { query: params });
    return { code: 0, message: 'success', salesorders: result.salesorders || [] };
  }

  /**
   * Zoho's list endpoints (Items, Contacts, ...) page results — capped at
   * 200 records per page by default, with a `page_context.has_more_page`
   * flag on the response telling you whether to fetch another page. Aug 27,
   * 2026: listItems/listContacts previously only ever fetched page 1, so a
   * real org with more than ~200 items or contacts had everything past that
   * cutoff silently missing from every sync — this is why a 200-count would
   * show up looking suspiciously exact. This helper loops until Zoho says
   * there's nothing more, for any list-shaped GET. Tolerant of a response
   * with no page_context at all (the local mock-server/ never includes
   * one) — that's treated as "one page, done," so mock/http-mock mode
   * behaves exactly as before.
   *
   * Aug 27, 2026 (2): a real org's contacts/items are being actively edited
   * by staff while a sync is in flight (confirmed — Subir reported a
   * specific customer just merged/updated in Zoho moments before a sync,
   * missing from the result). If Zoho's default list order is driven by a
   * mutable field (most "recently active first" views sort by
   * last-modified), a record edited mid-fetch can jump between pages and
   * end up skipped by a page-by-page walk. Sorting explicitly by
   * `created_time` ascending — a field that never changes on an edit or a
   * contact merge — makes the page boundaries stable for the whole walk
   * regardless of what happens in Zoho while it's running. A caller-passed
   * `sort_column`/`sort_order` in `params` still wins (spread after the
   * default), so this is purely a safer default, not a forced behavior.
   * Records are also de-duplicated by their id field on the way out, as a
   * second line of defense against any residual page drift.
   */
  async _paginatedList(path, resultKey, params = {}) {
    const perPage = 200;
    let page = 1;
    let all = [];
    // Safety cap, not a real expected ceiling (200 * 100 = 20,000 records)
    // — just a backstop against looping forever if a future API response
    // shape reports has_more_page=true without ever actually terminating.
    for (let guard = 0; guard < 100; guard++) {
      const result = await this._request('GET', path, {
        query: { sort_column: 'created_time', sort_order: 'A', ...params, page, per_page: perPage }
      });
      const pageRecords = result[resultKey] || [];
      all = all.concat(pageRecords);

      const hasMore = result.page_context?.has_more_page ?? result.has_more_page ?? false;
      if (!hasMore) break;
      page += 1;
    }

    const seen = new Set();
    const deduped = [];
    for (const record of all) {
      const id = record.contact_id || record.item_id || record.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      deduped.push(record);
    }
    return deduped;
  }

  async listContacts(params = {}) {
    const contacts = await this._paginatedList('/contacts', 'contacts', params);
    return { code: 0, message: 'success', contacts };
  }

  async listItems(params = {}) {
    const items = await this._paginatedList('/items', 'items', params);
    return { code: 0, message: 'success', items };
  }

  /**
   * Read-only: GET /contacts/{contact_id} — Zoho's "Get a Contact" detail
   * call, which (unlike List Contacts) includes billing_address. See
   * customers.controller.js's getZohoAddress for why this is fetched
   * per-customer on selection rather than for every contact during the
   * bulk sync-from-zoho pull.
   */
  async getContact(contactId) {
    const result = await this._request('GET', `/contacts/${contactId}`);
    return { code: 0, message: 'success', contact: result.contact };
  }
}

module.exports = LiveZohoAdapter;
