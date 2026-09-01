const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { isDryRunMode, getTestCustomerZohoIds } = require('../services/zohoTestFlags');
const syncJobs = require('../services/syncJobs');
const { getSyncState, setSyncState } = require('../services/syncState');

// Purely local classification tag for the Clients Directory (Aug 27, 2026).
// Kept strictly separate from `type` (credit/direct), which continues to
// drive payment-workflow routing unchanged — see schema.sql/migrate.js.
const ALLOWED_CATEGORIES = ['doctor', 'hospital', 'distributor', 'pwd'];
const DEFAULT_PAGE_SIZE = 25;

/**
 * GET /api/customers
 * Admin/management view of every local customer — the Clients Directory —
 * tagged with where it came from (source: 'zoho' vs 'local'), its Credit/
 * Direct payment type, its optional local category (doctor/hospital/
 * distributor/pwd), and whether it is the one customer currently allowed
 * to be used for a live Zoho Sales Order (see ZOHO_TEST_CUSTOMER_ID /
 * checkTestCustomerGate in orders.controller.js).
 * This is a broader view than orders.controller.js's getCustomers, which
 * is what the MedRep order-creation dropdown actually uses and is
 * filtered down to just the allowed test customer while the gate is on.
 *
 * Supports server-side pagination (?page, ?limit — defaults to 25/page,
 * matching the Inventory page) plus optional ?search (matches name/
 * contact_person/contact_number), ?category, and ?type filters.
 */
function getCustomersOverview(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const category = (req.query.category || '').trim().toLowerCase();
    const type = (req.query.type || '').trim().toLowerCase();

    const where = ['is_active = 1'];
    const params = [];

    if (search) {
      where.push('(name LIKE ? OR contact_person LIKE ? OR contact_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (category) {
      if (category === 'uncategorized') {
        where.push('category IS NULL');
      } else if (ALLOWED_CATEGORIES.includes(category)) {
        where.push('category = ?');
        params.push(category);
      }
    }
    if (type === 'credit' || type === 'direct') {
      where.push('type = ?');
      params.push(type);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS count FROM customers ${whereSql}`).get(...params).count;
    const customers = db
      .prepare(`SELECT * FROM customers ${whereSql} ORDER BY name LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    // Aug 31, 2026 (6): reads the full list now (TEST-CUSTOMER_1/2/3), not
    // just one id — see zohoTestFlags.js. Every designated test customer
    // gets the "Test" badge in this Directory, not only the first.
    const testZohoIds = getTestCustomerZohoIds();
    res.json({
      success: true,
      data: {
        customers: customers.map((c) => ({
          ...c,
          is_test_customer: testZohoIds.includes(c.zoho_contact_id)
        })),
        test_customer_gate_enabled: testZohoIds.length > 0,
        configured_test_zoho_contact_ids: testZohoIds,
        zoho_dry_run_enabled: isDryRunMode(),
        pagination: {
          total,
          page,
          limit,
          pages: Math.max(1, Math.ceil(total / limit))
        }
      }
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/customers/stats
 *
 * Aug 27, 2026 (2): the Clients Directory page originally fetched its four
 * KPI counts (Total/Credit/Direct/Uncategorized) as four separate
 * `GET /api/customers?limit=1` requests, each a full HTTP round trip just
 * to read a `pagination.total`. This does the same four counts as one
 * grouped local query — one request, one round trip, instead of five
 * (this call plus the paginated list) on every page load.
 */
function getCustomerStats(req, res, next) {
  try {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN type = 'credit' THEN 1 ELSE 0 END) AS credit,
           SUM(CASE WHEN type = 'direct' THEN 1 ELSE 0 END) AS direct,
           SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END) AS uncategorized
         FROM customers
         WHERE is_active = 1`
      )
      .get();

    res.json({
      success: true,
      data: {
        total: row.total || 0,
        credit: row.credit || 0,
        direct: row.direct || 0,
        uncategorized: row.uncategorized || 0
      }
    });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/customers/:id/category
 * Sets (or clears, with category: null) a customer's local classification
 * tag — doctor/hospital/distributor/pwd. Pure local UPDATE against the
 * `customers` table; nothing is ever sent to Zoho, and `type` (credit/
 * direct) is never touched by this endpoint.
 */
function updateCustomerCategory(req, res, next) {
  try {
    const { id } = req.params;
    let { category } = req.body || {};

    if (category !== null && category !== undefined) {
      category = String(category).trim().toLowerCase();
      if (category === '') category = null;
    }
    if (category !== null && category !== undefined && !ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CATEGORY',
          message: `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}, or null to clear`
        }
      });
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customer) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    }

    db.prepare('UPDATE customers SET category = ? WHERE id = ?').run(category ?? null, id);
    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

    res.json({ success: true, data: { customer: updated } });
  } catch (err) { next(err); }
}

/**
 * POST /api/customers/sync-from-zoho
 * Read-only pull: fetches contacts from Zoho (zoho.listContacts(), a GET)
 * and mirrors them into the local `customers` table — inserts new ones,
 * refreshes existing ones matched by zoho_contact_id. This NEVER writes
 * anything to Zoho; it is the read-side counterpart of the restriction
 * that createSalesOrder can no longer create or look up a Zoho contact.
 *
 * `type` (credit/direct) is inferred heuristically from Zoho's
 * customer_sub_type (business -> credit, else direct) since Zoho has no
 * equivalent of Getmeds' credit-vs-direct-patient distinction — an admin
 * can correct it locally afterwards if needed. This heuristic doesn't
 * matter for the single-TEST-customer safety gate itself, which keys off
 * zoho_contact_id, not type.
 */
/**
 * Shared reconciliation logic — INSERT new / UPDATE existing local
 * `customers` rows from a list of Zoho contacts. Pure local DB writes; the
 * Zoho read that produced `contacts` already happened before this is
 * called. Used by both the original synchronous sync-from-zoho endpoint
 * below (unchanged behavior/contract — tests/customersSync.test.js asserts
 * against it directly) and the new background Quick Sync / Full Resync
 * jobs (startSyncJob), so the two can never quietly drift apart.
 */
function reconcileContacts(contacts) {
  const findByZohoId = db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?');
  const insert = db.prepare(`
    INSERT INTO customers (name, type, zoho_contact_id, source, contact_person, contact_number, address, last_synced_at, is_active)
    VALUES (?, ?, ?, 'zoho', ?, ?, ?, datetime('now'), 1)
  `);
  const update = db.prepare(`
    UPDATE customers SET name = ?, contact_person = ?, contact_number = ?, address = ?, last_synced_at = datetime('now')
    WHERE zoho_contact_id = ?
  `);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const txn = db.transaction(() => {
    for (const contact of contacts) {
      if (!contact.contact_id) { skipped++; continue; }

      const name = contact.contact_name || contact.company_name || 'Unnamed Zoho Contact';
      const type = contact.customer_sub_type === 'business' ? 'credit' : 'direct';
      const contactPerson = contact.first_name
        ? `${contact.first_name} ${contact.last_name || ''}`.trim()
        : null;
      const phone = contact.phone || contact.mobile || null;
      const address = contact.billing_address
        ? [contact.billing_address.address, contact.billing_address.city].filter(Boolean).join(', ')
        : null;

      const existing = findByZohoId.get(contact.contact_id);
      if (existing) {
        update.run(name, contactPerson, phone, address, contact.contact_id);
        updated++;
      } else {
        insert.run(name, type, contact.contact_id, contactPerson, phone, address);
        created++;
      }
    }
  });
  txn();

  return { created, updated, skipped };
}

async function syncFromZoho(req, res, next) {
  try {
    const result = await zoho.listContacts();
    const contacts = result.contacts || [];

    const { created, updated, skipped } = reconcileContacts(contacts);

    // Aug 28, 2026: listContacts' pagination loop now reports whether it
    // stopped because of its own internal safety cap rather than because
    // Zoho actually ran out of pages (see LiveZohoAdapter.js's
    // _paginatedList) — surface that here instead of silently reporting a
    // count that looks complete but isn't. This is what was happening
    // when specific real customers (e.g. "Ma. Isabel Mahinay") were
    // visible in Zoho but never showed up here no matter how many times
    // this sync ran.
    const message = result.truncated
      ? `⚠️ Pulled ${contacts.length} contact(s) from Zoho, but Zoho reported even MORE contacts exist beyond ` +
        `this pull's safety limit — this sync is INCOMPLETE (${created} new, ${updated} refreshed` +
        (skipped ? `, ${skipped} skipped` : '') + `). Nothing was written to Zoho. Contact whoever maintains ` +
        'this app so the safety cap can be raised further.'
      : `Pulled ${contacts.length} contact(s) from Zoho — ${created} new, ${updated} refreshed` +
        (skipped ? `, ${skipped} skipped (no contact_id)` : '') +
        '. Nothing was written to Zoho.';

    res.json({
      success: true,
      message,
      data: { total_from_zoho: contacts.length, created, updated, skipped, truncated: !!result.truncated }
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/customers/sync-from-zoho/start?mode=quick|full
 *
 * Aug 28, 2026: added ALONGSIDE the plain POST /sync-from-zoho above —
 * that endpoint is untouched (tests/customersSync.test.js asserts its
 * synchronous, same-request contract directly), so this is purely
 * additive, never a replacement.
 *
 * Kicks the pull off in the background and returns a job id right away
 * (202) instead of making the request wait however long a full pull of a
 * large Zoho org takes — poll progress at GET /api/sync-jobs/:jobId.
 *
 *  - mode=quick: only contacts modified since the last recorded watermark
 *    (see services/syncState.js) — fast, and this also naturally catches
 *    edits/merges to EXISTING contacts (e.g. the Aug 27 "Ma. Isabel
 *    Mahinay" merge), not just brand-new ones, since an edit bumps Zoho's
 *    last_modified_time. The very first run ever has no watermark yet, so
 *    it behaves like a one-time full pull to establish one.
 *  - mode=full: every contact, guaranteed complete — the same
 *    created_time-ascending walk the plain endpoint above already uses —
 *    for "make sure literally everyone, registered here or not, is in the
 *    system."
 *
 * Still a pure READ (zoho.listContacts()) — nothing here is ever written
 * back to Zoho, same as everything else in this file.
 */
async function startSyncJob(req, res) {
  const mode = String(req.query.mode || '').toLowerCase();
  if (mode !== 'quick' && mode !== 'full') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_MODE', message: 'Query param "mode" must be "quick" or "full".' }
    });
  }

  const job = syncJobs.createJob({ type: 'customers', mode });

  if (mode === 'full') {
    const priorTotal = parseInt(getSyncState('customers_last_full_total'), 10);
    if (priorTotal > 0) syncJobs.updateProgress(job.id, { total: priorTotal });
  }

  res.status(202).json({ success: true, data: { job_id: job.id, mode } });

  // Fire-and-forget from here — the HTTP response above has already gone
  // out. Everything below only ever updates the in-memory job (polled
  // separately via GET /api/sync-jobs/:jobId) and the local database —
  // never anything back to Zoho.
  (async () => {
    try {
      const opts = {
        onPage: ({ processed }) => syncJobs.updateProgress(job.id, { processed })
      };
      if (mode === 'quick') {
        const watermark = getSyncState('customers_last_modified_watermark');
        if (watermark) opts.sinceWatermark = watermark;
      }

      const result = await zoho.listContacts({}, opts);
      const contacts = result.contacts || [];
      const { created, updated, skipped } = reconcileContacts(contacts);

      if (result.newWatermark) setSyncState('customers_last_modified_watermark', result.newWatermark);
      if (mode === 'full') {
        setSyncState('customers_last_full_sync_at', new Date().toISOString());
        setSyncState('customers_last_full_total', contacts.length);
      }

      syncJobs.finishJob(job.id, {
        mode,
        total_from_zoho: contacts.length,
        created,
        updated,
        skipped,
        truncated: !!result.truncated,
        stopped_early: !!result.stoppedEarly
      });
    } catch (err) {
      console.error('[CUSTOMERS] background sync job failed:', err);
      syncJobs.failJob(job.id, err);
    }
  })();
}

/**
 * GET /api/customers/:id/address-from-zoho
 *
 * Aug 27, 2026: Zoho's List Contacts response (what sync-from-zoho pulls in
 * bulk, above) never includes billing_address — only the single "Get a
 * Contact" detail call does. That's why, before this endpoint existed, a
 * synced customer's `address` column stayed NULL forever and the MedRep
 * order form's Address field never auto-filled even though Zoho clearly has
 * that data. Fetching every contact's full detail during the bulk sync
 * would multiply that pull's API calls by however many customers exist
 * (hundreds, for a real org) for data most of them will never need in a
 * given session — so instead this is a per-customer, on-demand read,
 * called the moment a MedRep actually selects that customer on the order
 * form. Still a pure GET (zoho.getContact) — nothing is ever written to
 * Zoho — and the result is cached onto the local row so re-selecting the
 * same customer later doesn't need another Zoho round trip.
 */
async function getZohoAddress(req, res, next) {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });

    // Local-only customer (never synced from Zoho) — nothing more accurate
    // to fetch; just hand back whatever's already stored.
    if (!customer.zoho_contact_id) {
      return res.json({
        success: true,
        data: { address: customer.address, contact_person: customer.contact_person, contact_number: customer.contact_number, synced_from_zoho: false }
      });
    }

    let contact;
    try {
      const result = await zoho.getContact(customer.zoho_contact_id);
      contact = result?.contact;
    } catch (zohoErr) {
      // Don't let a Zoho hiccup block selecting a customer on the order
      // form — fall back to whatever's already cached locally.
      console.warn(`[CUSTOMERS] getContact failed for ${customer.zoho_contact_id}:`, zohoErr.message);
      return res.json({
        success: true,
        data: { address: customer.address, contact_person: customer.contact_person, contact_number: customer.contact_number, synced_from_zoho: false, zoho_error: zohoErr.message }
      });
    }

    if (!contact) {
      return res.json({
        success: true,
        data: { address: customer.address, contact_person: customer.contact_person, contact_number: customer.contact_number, synced_from_zoho: false }
      });
    }

    const billing = contact.billing_address || contact.shipping_address || null;
    const address = billing
      ? [billing.address, billing.street2, billing.city, billing.state, billing.zip, billing.country].filter(Boolean).join(', ')
      : customer.address;
    const contactPerson = contact.first_name
      ? `${contact.first_name} ${contact.last_name || ''}`.trim()
      : (customer.contact_person || null);
    const contactNumber = contact.phone || contact.mobile || customer.contact_number || null;

    db.prepare(`
      UPDATE customers SET address = ?, contact_person = ?, contact_number = ?, last_synced_at = datetime('now')
      WHERE id = ?
    `).run(address || null, contactPerson, contactNumber, customer.id);

    res.json({ success: true, data: { address, contact_person: contactPerson, contact_number: contactNumber, synced_from_zoho: true } });
  } catch (err) { next(err); }
}

module.exports = {
  getCustomersOverview,
  syncFromZoho,
  startSyncJob,
  getZohoAddress,
  updateCustomerCategory,
  getCustomerStats,
  ALLOWED_CATEGORIES
};
