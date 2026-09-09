const ZohoAdapter = require('./ZohoAdapter');
const { findSalesperson, SalespersonNotFoundError } = require('./salespersonName');

// Sep 2, 2026 — network resilience, added after a Full Resync died with the
// famously unhelpful "fetch failed". See _request below for why retries are
// GET-only.
const REQUEST_TIMEOUT_MS = Number(process.env.ZOHO_REQUEST_TIMEOUT_MS) || 30000;
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.ZOHO_REQUEST_RETRIES) || 3);
const RETRY_BASE_MS = Number(process.env.ZOHO_REQUEST_RETRY_BASE_MS) || 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turn undici's opaque `TypeError: fetch failed` into something that names
 * the actual problem.
 *
 * Node's fetch reports every transport-level failure — DNS, TLS, refused
 * connection, timeout, proxy — with the same three words, and puts the real
 * reason on `err.cause`. Reporting only the wrapper is why "Full Resync
 * failed: fetch failed" tells nobody anything; the cause underneath says
 * ENOTFOUND, or ConnectTimeoutError, or a certificate error, and each of
 * those has a completely different fix.
 */
function describeNetworkError(err, url, method) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    const e = new Error(
      `Zoho did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${method} ${new URL(url).pathname}). ` +
        'Raise ZOHO_REQUEST_TIMEOUT_MS if the org is simply slow.'
    );
    e.cause = err;
    return e;
  }

  const cause = err?.cause;
  const code = cause?.code || err?.code;
  const detail = [code, cause?.message].filter(Boolean).join(': ') || err?.message || 'unknown network error';

  const hints = {
    ENOTFOUND: 'DNS could not resolve the host — check ZOHO_API_BASE_URL, and that this machine is online.',
    EAI_AGAIN: 'DNS lookup failed temporarily — usually no internet, or a VPN/proxy in the way.',
    ECONNREFUSED: 'The connection was refused — wrong host/port, or something is blocking outbound HTTPS.',
    ECONNRESET: 'The connection was reset mid-request — often a corporate proxy or firewall interfering.',
    UND_ERR_CONNECT_TIMEOUT: 'Could not establish a connection in time — network, VPN, or firewall.',
    UND_ERR_HEADERS_TIMEOUT: 'Zoho accepted the connection but sent no response in time.',
    CERT_HAS_EXPIRED: 'TLS certificate rejected — usually a proxy doing HTTPS interception.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS chain could not be verified — usually a proxy doing HTTPS interception.'
  };

  const e = new Error(
    `Could not reach Zoho (${method} ${new URL(url).host}): ${detail}` +
      (hints[code] ? ` — ${hints[code]}` : '')
  );
  e.cause = err;
  e.networkCode = code || null;
  return e;
}

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

    // Sep 2, 2026: retries, but ONLY for GET.
    //
    // A Full Resync is ~475 sequential page requests against a 95k-contact
    // org. One transient blip anywhere in that sequence used to abort the
    // whole job and throw away every page already fetched, which is how
    // "Full Resync failed: fetch failed" happens on a connection that is
    // basically fine.
    //
    // POST is deliberately NOT retried. `createSalesOrder` is the only POST
    // this class makes, and a network error tells you nothing about whether
    // Zoho received it — retrying could put a SECOND real Sales Order in the
    // company's org. A failed create belongs in zohoRetryService's outbox,
    // where the payload is rebuilt and a human decides, not in a silent
    // loop here.
    const retryable = method === 'GET';
    const attempts = retryable ? RETRY_ATTEMPTS : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method,
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json'
          },
          body: body ? JSON.stringify(body) : undefined,
          // Without this a stalled connection hangs until Node's own
          // default gives up, with the job sitting at "running" throughout.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (err) {
        // `fetch failed` is undici's generic wrapper and says nothing on its
        // own — the real reason (ENOTFOUND, ECONNRESET, ConnectTimeoutError,
        // a TLS failure, a proxy refusing) is on err.cause. Unwrapping it
        // here is the difference between an unactionable message and one
        // that names what to fix.
        lastError = describeNetworkError(err, url, method);
        if (attempt < attempts) {
          const wait = RETRY_BASE_MS * attempt;
          this._log(`[ZOHO_${this._modeLabel.toUpperCase()}] ${method} ${path} failed (${lastError.message}) — retry ${attempt}/${attempts - 1} in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw lastError;
      }

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // 429 (rate limited) and 5xx are worth another go on a GET; a 4xx
        // like a bad org id or a revoked token will fail identically every
        // time, so retrying it just delays the real message.
        const worthRetrying = retryable && (resp.status === 429 || resp.status >= 500);
        const err = new Error(json.message || `Zoho API error (HTTP ${resp.status})`);
        err.zohoResponse = json;
        err.httpStatus = resp.status;

        if (worthRetrying && attempt < attempts) {
          const wait = RETRY_BASE_MS * attempt * (resp.status === 429 ? 4 : 1);
          this._log(`[ZOHO_${this._modeLabel.toUpperCase()}] ${method} ${path} HTTP ${resp.status} — retry ${attempt}/${attempts - 1} in ${wait}ms`);
          await sleep(wait);
          lastError = err;
          continue;
        }
        throw err;
      }
      return json;
    }

    throw lastError || new Error(`Zoho request failed: ${method} ${path}`);
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

    // Sep 8, 2026: Delivery Method and Terms — plain top-level fields Zoho's
    // Sales Order create API already accepts; they were simply never set
    // here before, so nothing this app collected on the order form ever
    // reached Zoho even after orders.controller.js started sending them in
    // orderData. Omitted (left alone in Zoho) rather than sent as an empty
    // string when not provided, same convention as the custom fields below.
    if (orderData.delivery_method) body.delivery_method = orderData.delivery_method;
    if (orderData.terms) body.terms = orderData.terms;

    // Sep 8, 2026 (2): Payment Terms. Confirmed live (SO-67174, this org)
    // that Zoho's real Sales Order fields are `payment_terms` — an integer
    // day-count — and `payment_terms_label` — the display string — sent
    // TOGETHER; editing "Payment Terms" directly in Zoho's UI to "30 days"
    // produced exactly payment_terms:30, payment_terms_label:"30 days" on
    // the object. This app only ever collects one free-text value (Net 15 /
    // 30 days / 45 Day / BPO WALLET / 60 Day / DSWD/PCSO / custom typed
    // text), so the day-count is derived by pulling the first number out of
    // whatever was typed or picked — covers every preset above that has one.
    // A term with no day count at all (BPO WALLET, DSWD/PCSO, or other
    // custom text with no digits) sends 0: a harmless placeholder for the
    // numeric field, while `payment_terms_label` still carries the exact
    // text through to Zoho's own Sales Order screen, same as a human typing
    // a custom label there would produce.
    if (orderData.payment_terms) {
      const paymentTermsLabel = String(orderData.payment_terms).trim();
      const dayMatch = paymentTermsLabel.match(/(\d+)/);
      body.payment_terms = dayMatch ? parseInt(dayMatch[1], 10) : 0;
      body.payment_terms_label = paymentTermsLabel;
    }

    // Aug 30, 2026: this Zoho org has "Salesperson" configured as a
    // mandatory field on every Sales Order — Zoho rejects creation with
    // "Salesperson cannot be empty" otherwise (confirmed live, see the
    // ZOHO_SYNC_FAILED audit entries on TestGM-20260830-0001).
    //
    // Sep 2, 2026 (2): the rest of what used to be written here was WRONG,
    // and the correction is why this sends an id instead of a name.
    //
    // It said Zoho matches by name and rejects a name it does not recognise,
    // so sending one was safe: worst case a failed order. It does not reject
    // it. It CREATES it. Reading GET /salespersons on this org turns up
    // "TEST | Juan dela Cruz" and "TEST | Aaron Manila", both with ids in the
    // recent range, neither typed by a human — this app made them by sending
    // names during testing. So `createSalesOrder` was never the only write
    // this adapter performed; it was quietly appending to a list the whole
    // company uses, and the pre-check on the order form was guarding against
    // a rejection that never happens.
    //
    // Resolving to a salesperson_id closes it. An unmatched name throws here
    // rather than travelling to Zoho, so the failure is loud, local, and
    // fixable — and no typo can add another row. The TestGM- "TEST | MEDREP"
    // fallback is gone for the same reason: it was one more unmatched name
    // waiting to be created.
    const salespersonName = (orderData.salesperson_name || '').trim();
    if (!salespersonName) {
      throw new SalespersonNotFoundError(null);
    }
    const salespersonId = await this._resolveSalespersonId(salespersonName);
    if (!salespersonId) {
      throw new SalespersonNotFoundError(salespersonName);
    }
    body.salesperson_id = salespersonId;

    // Aug 30, 2026 (3): "Doctor Name" and "Source" — confirmed live (via
    // ZohoInventory_get_sales_order on an existing real Sales Order in this
    // exact org) that both are already configured as custom fields here,
    // with these exact customfield_ids:
    //   cf_doctor_name (string)   -> 2254168001890600053
    //   cf_source      (dropdown) -> 2254168001929089177, whose existing
    //     option labels already match this app's Source dropdown 1:1 (e.g.
    //     "Patient order referred by doctor"), so sending the plain label
    //     as `value` resolves to the matching option rather than needing
    //     its `selected_option_id`.
    // Aug 30, 2026 (4): "Invoicing From" — same discovery, same org: this is
    // NOT a second Zoho organization (as ZOHO_SALES_ORDER_FIELD_MAPPING.md
    // originally assumed) — it's just another already-configured custom
    // field here:
    //   cf_invoicing_from (dropdown) -> 2254168001900812580, options
    //     "2mg Incorporated" / "Getmeds Philippines Inc." matching this
    //     app's own Invoicing From dropdown 1:1.
    // Only sent when the order actually has a value — an empty/omitted
    // custom field is simply left blank in Zoho rather than overwritten
    // with an empty string.
    const customFields = [];
    if (orderData.doctor_name) {
      customFields.push({ customfield_id: '2254168001890600053', value: orderData.doctor_name });
    }
    if (orderData.order_source) {
      customFields.push({ customfield_id: '2254168001929089177', value: orderData.order_source });
    }
    if (orderData.invoicing_from) {
      customFields.push({ customfield_id: '2254168001900812580', value: orderData.invoicing_from });
    }
    // Sep 2, 2026: "Division" and "Sub-division" — the two custom fields
    // sitting directly under Salesperson on this org's Sales Order screen.
    //
    // Sep 7, 2026: the Division id below was WRONG — '2254168002003349004'
    // does not exist anywhere in this org's actual custom-field list (Sales
    // Order module), confirmed live via Zoho_Books list_custom_fields
    // (entity=salesorder, 60 fields returned, that id is not among them).
    // Every order with a Division value was failing Zoho sync with "One or
    // more custom field(s) does not exist" and queuing for a retry that
    // could never succeed, since the id itself was never going to start
    // existing. The real field is api_name `cf_division_1` (label
    // "Division", field_id 2254168002004367051) — the "_1" suffix suggests
    // an earlier `cf_division` field was deleted and recreated in Zoho at
    // some point after this was first wired, silently invalidating the id
    // this file had. Sub-division's id was re-checked the same way and IS
    // correct (field_id 2254168002003349006, api_name cf_sub_division,
    // present and active) — only Division's was stale:
    //   cf_division_1   (text) -> 2254168002004367051
    //   cf_sub_division (text) -> 2254168002003349006
    // Both plain text, so the value goes across as typed.
    //
    // These come from the ordering MedRep's own account (users.division /
    // users.sub_division, collected at sign-up) — the same row the
    // Salesperson string is generated from, so the three always describe one
    // person. Sub-division is optional and simply omitted when blank, like
    // every other custom field here: an omitted field is left alone in Zoho
    // rather than overwritten with an empty string.
    if (orderData.division) {
      customFields.push({ customfield_id: '2254168002004367051', value: orderData.division });
    }
    if (orderData.sub_division) {
      customFields.push({ customfield_id: '2254168002003349006', value: orderData.sub_division });
    }
    // Sep 8, 2026 (3): "GM Lead ID" — confirmed live via Zoho_Books
    // list_custom_fields (entity=salesorder) that this org already has
    // cf_gm_lead_id configured (field_id 2254168000497964391, plain text,
    // not mandatory). Carries the identity of whichever admin/management
    // account created this order on someone's behalf — the same value the
    // order form's "Admin" field shows, previously never sent to Zoho at
    // all (see orders.controller.js's gmLeadId note). Blank/omitted for an
    // order a MedRep created themselves, same "don't send an empty
    // overwrite" convention as every other custom field here.
    if (orderData.gm_lead_id) {
      customFields.push({ customfield_id: '2254168000497964391', value: orderData.gm_lead_id });
    }
    if (customFields.length) {
      body.custom_fields = customFields;
    }

    // Sep 9, 2026: Expected Shipment Date. `shipment_date` is a standard
    // top-level Sales Order field in Zoho Books — it is even returned by the
    // List Sales Orders endpoint — so no custom field is involved. Omitted
    // entirely when blank, the same convention as every optional field here:
    // an omitted field leaves Zoho's own default alone rather than writing an
    // empty string over it.
    if (orderData.expected_shipment_date) {
      body.shipment_date = orderData.expected_shipment_date;
    }

    const result = await this._request('POST', '/salesorders', { body });
    return { code: 0, message: 'Sales order created successfully', salesorder: result.salesorder };
  }

  async getSalesOrder(salesorderId) {
    const result = await this._request('GET', `/salesorders/${salesorderId}`);
    return { code: 0, message: 'success', salesorder: result.salesorder };
  }

  /**
   * One page, newest first. Sorted by created_time descending and capped by
   * per_page, so exactly one HTTP GET leaves this process however large the
   * org's Sales Order history is.
   */
  async listRecentSalesOrders(limit = 5) {
    const perPage = Math.max(1, Math.min(200, Number(limit) || 5));
    const result = await this._request('GET', '/salesorders', {
      query: { sort_column: 'created_time', sort_order: 'D', page: 1, per_page: perPage }
    });
    return { code: 0, message: 'success', salesorders: (result.salesorders || []).slice(0, perPage) };
  }

  /**
   * Every Sales Order in the org.
   *
   * Sep 9, 2026: this used to be a single un-paginated GET — one page, so at
   * most 200 Sales Orders however many the org actually has, with nothing to
   * say the rest existed. That is the same bug _paginatedList was written for
   * on Aug 27 for contacts and items (see its doc comment); listSalesOrders
   * simply never got the same treatment, because until the bulk import
   * arrived its only caller was a demo script that read five.
   *
   * Now it goes through the same walk as contacts and items, which also gets
   * it the stable created_time ordering, the onPage progress callback and the
   * sinceWatermark Quick Sync mode for free.
   */
  async listSalesOrders(params = {}, opts = {}) {
    const { records: salesorders, truncated, newWatermark, stoppedEarly } = await this._paginatedList(
      '/salesorders',
      'salesorders',
      params,
      opts
    );
    return { code: 0, message: 'success', salesorders, truncated, newWatermark, stoppedEarly };
  }

  /**
   * GET /salesorders/{id}/comments — Zoho's own "Comments & History" log for
   * one Sales Order. See ZohoAdapter.listSalesOrderComments for why this
   * exists and why it is still not a write.
   *
   * Not run through _paginatedList: this is one order's history, tens of
   * entries at the very most, and Zoho returns it whole.
   */
  async listSalesOrderComments(salesorderId) {
    const result = await this._request('GET', `/salesorders/${salesorderId}/comments`);
    return { code: 0, message: 'success', comments: result.comments || [] };
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
   *
   * Aug 28, 2026: the guard below used to stop at 100 iterations (200 *
   * 100 = 20,000 records), written as "just a backstop, not a real
   * ceiling" — but Getmeds' real Zoho org now has more contacts than that,
   * so the "backstop" was silently firing for real on every sync, capping
   * the pull at exactly 20,000 with no warning anywhere (the same
   * "suspiciously round number" symptom this file's Aug 27 fix was written
   * to catch, just one order of magnitude bigger). Confirmed directly:
   * `customers.zoho_contact_id`-tagged rows in the local DB cluster into
   * exactly two `last_synced_at` groups, 15,885 and 20,000 — real
   * customers Subir could see in Zoho (e.g. "Ma. Isabel Mahinay" and
   * several other real "Isabel"-named clients) simply sort past position
   * 20,000 in created_time order and were never fetched by either run.
   * Raised the cap by 10x (2,000,000 records) so it's a true backstop
   * again relative to this org's actual size, and this now also reports
   * whether the cap was hit — `truncated: true` — so a sync that
   * genuinely runs out of guard iterations tells the caller instead of
   * quietly handing back a partial list that looks complete.
   *
   * Aug 28, 2026 (2): added two purely additive, opt-in things behind a new
   * `opts` argument (default `{}`) so every existing call — including the
   * two above with no third argument at all — keeps its exact current
   * behavior (full walk, created_time ascending, no callback):
   *
   *  - `opts.onPage({ processed, page, hasMorePages })`, invoked once per
   *    page fetched, purely for progress reporting (see services/
   *    syncJobs.js). A throwing callback is swallowed — a bug in progress
   *    reporting must never break the underlying sync.
   *  - `opts.sinceWatermark` (a string, e.g. a prior `last_modified_time`)
   *    switches this into "Quick Sync" mode: pages are fetched sorted by
   *    `opts.watermarkField` (default `last_modified_time`) DESCENDING
   *    instead of `created_time` ascending, and the walk stops the moment
   *    it reaches a record at or before that watermark — everything newer
   *    is by definition on earlier pages already collected. This also
   *    naturally catches edits/merges to EXISTING contacts (e.g. the Aug 27
   *    "Ma. Isabel Mahinay" merge), not just brand-new ones, since an edit
   *    bumps last_modified_time.
   *
   * Regardless of mode, this now also tracks and returns `newWatermark` —
   * the maximum `watermarkField` value seen across every record actually
   * returned — so the caller can persist it (services/syncState.js) as the
   * starting point for the NEXT Quick Sync. A caller-passed
   * `sort_column`/`sort_order` in `params` still wins over either default
   * (spread after it), same as before.
   */
  async _paginatedList(path, resultKey, params = {}, opts = {}) {
    const perPage = 200;
    let page = 1;
    let all = [];
    let truncated = false;
    let stoppedEarly = false;
    let newWatermark = null;
    const watermarkField = opts.watermarkField || 'last_modified_time';
    const sinceWatermark = opts.sinceWatermark || null;

    const defaultSort = sinceWatermark
      ? { sort_column: watermarkField, sort_order: 'D' }
      : { sort_column: 'created_time', sort_order: 'A' };

    // Safety cap, not a real expected ceiling (200 * 10,000 = 2,000,000
    // records) — just a backstop against looping forever if a future API
    // response shape reports has_more_page=true without ever actually
    // terminating. See the note above for why this was raised from 100.
    const MAX_ITERATIONS = 10000;
    for (let guard = 0; guard < MAX_ITERATIONS; guard++) {
      const result = await this._request('GET', path, {
        query: { ...defaultSort, ...params, page, per_page: perPage }
      });
      const pageRecords = result[resultKey] || [];

      for (const record of pageRecords) {
        const wm = record[watermarkField];
        if (wm && (!newWatermark || wm > newWatermark)) newWatermark = wm;

        if (sinceWatermark && wm && wm <= sinceWatermark) {
          // Sorted descending by watermarkField, so everything from this
          // record on (rest of this page, and every later page) is already
          // reflected locally — stop collecting here (the inner loop only;
          // onPage below still fires once for this final, partial page so
          // a quick sync that stops on page 1 still reports its progress
          // instead of jumping straight from 0% to done).
          stoppedEarly = true;
          break;
        }
        all.push(record);
      }

      if (opts.onPage) {
        try {
          opts.onPage({
            processed: all.length,
            page,
            hasMorePages: result.page_context?.has_more_page ?? result.has_more_page ?? false
          });
        } catch (_) {
          // Progress reporting must never take down the actual sync.
        }
      }

      if (stoppedEarly) break;

      const hasMore = result.page_context?.has_more_page ?? result.has_more_page ?? false;
      if (!hasMore) break;
      if (guard === MAX_ITERATIONS - 1) {
        truncated = true;
        this._log(
          `[ZOHO_${this._modeLabel.toUpperCase()}] _paginatedList(${path}) hit its ${MAX_ITERATIONS}-page safety ` +
            `cap (${MAX_ITERATIONS * perPage} records) while Zoho still reports more pages — stopping early. ` +
            'This should only ever happen if Zoho is stuck reporting has_more_page=true forever; if this is a ' +
            'real, growing org, raise MAX_ITERATIONS again.'
        );
      }
      page += 1;
    }

    const seen = new Set();
    const deduped = [];
    for (const record of all) {
      // Sep 9, 2026: salesorder_id added when listSalesOrders started
      // going through this walk — without it every Sales Order fell to the
      // `record.id` fallback, which Zoho's Sales Order objects do not have,
      // so the de-duplication silently did nothing for them.
      const id = record.contact_id || record.item_id || record.salesorder_id || record.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      deduped.push(record);
    }
    return { records: deduped, truncated, newWatermark, stoppedEarly };
  }

  async listContacts(params = {}, opts = {}) {
    const { records: contacts, truncated, newWatermark, stoppedEarly } = await this._paginatedList(
      '/contacts',
      'contacts',
      params,
      opts
    );
    return { code: 0, message: 'success', contacts, truncated, newWatermark, stoppedEarly };
  }

  async listItems(params = {}, opts = {}) {
    const { records: items, truncated, newWatermark, stoppedEarly } = await this._paginatedList(
      '/items',
      'items',
      params,
      opts
    );
    return { code: 0, message: 'success', items, truncated, newWatermark, stoppedEarly };
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

  /**
   * Read-only: GET /salespersons — the org's configured Salespersons.
   *
   * Sep 2, 2026. Not run through _paginatedList: Zoho returns the whole
   * Salesperson list in one response (there are tens of these, not the
   * ~95k contacts that made pagination necessary), so walking pages here
   * would be machinery with nothing to do.
   *
   * A plain GET. This adapter has no method that creates a Salesperson,
   * and this one does not become that by accident.
   *
   * Sep 2, 2026 (2): this endpoint answers under `data`, NOT `salespersons`.
   * Every other list endpoint in this API names its array after the resource
   * (`contacts`, `items`, `salesorders`), so `result.salespersons` looked
   * right and was verified against MockZohoAdapter, which returns exactly
   * that shape. The result was a bug no test could see: live returned `[]`
   * for an org with a populated list, and because an empty list is a
   * perfectly valid answer, nothing threw. Every name checked against it came
   * back `exists: false`.
   *
   * Both keys are read, and the mock's shape stays valid — but the ordering
   * matters: `data` is what the real API sends.
   */
  /**
   * A name -> salesperson_id lookup against the live list, cached briefly.
   *
   * Same TTL knob as services/salespersonService (ZOHO_SALESPERSON_CACHE_MS):
   * the list changes when somebody edits it in Zoho, which is rarely, and a
   * burst of order submissions should not mean a burst of identical reads.
   * Per-adapter and in-memory, so it dies with the process.
   */
  async _resolveSalespersonId(name) {
    const ttl = Number(process.env.ZOHO_SALESPERSON_CACHE_MS) || 5 * 60 * 1000;
    const now = Date.now();
    if (!this._salespersonCache || now - this._salespersonCache.fetchedAt > ttl) {
      const { salespersons } = await this.listSalespersons();
      this._salespersonCache = { salespersons, fetchedAt: now };
    }
    const match = findSalesperson(this._salespersonCache.salespersons, name);
    return match ? match.salesperson_id : null;
  }

  async listSalespersons() {
    const result = await this._request('GET', '/salespersons');
    const salespersons = result.data || result.salespersons || [];
    return { code: 0, message: 'success', salespersons };
  }

  /**
   * Write EXACTLY ONE custom field — `cf_tin` — on an existing Zoho
   * contact. See ZohoAdapter.js's Sep 8, 2026 note for why this narrow
   * exception to the create-only policy exists.
   *
   * `customfield_id` 2254168001928321297 is the TIN field on this exact
   * org, confirmed live via Zoho_Books list_custom_fields (entity=contact):
   * api_name `cf_tin`, label "TIN", data_type string. The request body
   * below carries `custom_fields` with only that one entry — Zoho's Update
   * a Contact API only touches the fields present in the body, so nothing
   * else about the contact (name, address, type, ...) is ever sent or
   * changed by this call.
   */
  async updateContactTin(contactId, tin) {
    if (!contactId) throw new Error('updateContactTin requires a Zoho contact id');
    const value = String(tin || '').trim();
    if (!value) throw new Error('updateContactTin requires a non-empty tin value');

    const body = {
      custom_fields: [{ customfield_id: '2254168001928321297', value }]
    };
    const result = await this._request('PUT', `/contacts/${contactId}`, { body });
    return { code: 0, message: 'Contact TIN updated successfully', contact: result.contact };
  }

  /**
   * Add ONE file to an existing Zoho Sales Order's "Attach File(s)"
   * section. See ZohoAdapter.js's Sep 8, 2026 (2) note for why this narrow,
   * add-only exception exists.
   *
   * POST /salesorders/{salesorder_id}/attachment, multipart/form-data with
   * field name "attachment" — Zoho's Sales Order attachment endpoint isn't
   * fully documented publicly, but this exact path/field-name shape is
   * confirmed against Zoho's documented Invoice attachment endpoint
   * (POST /invoices/{invoice_id}/attachment), and Zoho's attachment API is
   * consistent across Books/Inventory modules. NOT yet confirmed live
   * against an image file on THIS org — do that before relying on this in
   * production (see the doc this shipped with for the exact test to run).
   *
   * Bypasses this._request() deliberately: that helper always sends
   * Content-Type: application/json, which is wrong for a multipart upload
   * — fetch needs to set its own boundary header from the FormData body.
   */
  async addSalesOrderAttachment(salesorderId, file) {
    if (!salesorderId) throw new Error('addSalesOrderAttachment requires a Zoho Sales Order id');
    const { buffer, filename, contentType } = file || {};
    if (!buffer || !buffer.length) throw new Error('addSalesOrderAttachment requires non-empty file data');

    this._assertOrgAllowed();
    const token = await this.getAccessToken();
    const params = new URLSearchParams({ organization_id: this.organizationId });
    const url = `${this.baseUrl}/salesorders/${salesorderId}/attachment?${params.toString()}`;

    const form = new FormData();
    form.append(
      'attachment',
      new Blob([buffer], { type: contentType || 'application/octet-stream' }),
      filename || 'attachment'
    );

    this._log(
      `[ZOHO_${this._modeLabel.toUpperCase()}] POST /salesorders/${salesorderId}/attachment ` +
        `(org=${this.organizationId}, file=${filename || 'attachment'})`
    );

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        // No Content-Type here on purpose — fetch derives the multipart
        // boundary from the FormData body itself; setting it manually
        // would break the boundary and Zoho would reject the upload.
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      // Not retried, same reasoning as createSalesOrder's POST: a network
      // error here doesn't say whether Zoho received the file, and this is
      // a soft-gated best-effort call from the caller's side anyway (see
      // paymentProof.controller.js) — a human can just re-open the order
      // and the local attachment is never lost either way.
      throw describeNetworkError(err, url, 'POST');
    }

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(json.message || `Zoho API error (HTTP ${resp.status})`);
      err.zohoResponse = json;
      err.httpStatus = resp.status;
      throw err;
    }
    return { code: 0, message: 'Attachment added successfully', document: json.document || json };
  }
}

module.exports = LiveZohoAdapter;
