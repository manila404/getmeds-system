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
async function getCustomersOverview(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const category = (req.query.category || '').trim().toLowerCase();
    const type = (req.query.type || '').trim().toLowerCase();
    // Sep 2, 2026: ?status=active|inactive|all. Defaults to 'active', which
    // is exactly what this endpoint did before the filter existed — the
    // difference is that the inactive ones are now reachable at all.
    // `is_active` mirrors Zoho's own contact status (reconcileContacts
    // below); before that mirroring landed, every row read as active and
    // this filter would have had nothing to show.
    const status = (req.query.status || 'active').trim().toLowerCase();

    const where = [];
    const params = [];
    if (status === 'active') where.push('is_active = 1');
    else if (status === 'inactive') where.push('is_active = 0');
    // 'all' adds no clause.

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

    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM customers ${whereSql}`).get(...params)).count;
    const customers = await db
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
async function getCustomerStats(req, res, next) {
  try {
    const row = await db
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

    // Sep 2, 2026: the KPI cards keep counting ACTIVE clients — that is what
    // "Total Clients" has always meant here and changing it silently would
    // move a number people read every day. The active/inactive split is
    // reported alongside instead, so the Status filter can show how many it
    // would reveal without redefining anything above it.
    const split = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive
         FROM customers`
      )
      .get();

    res.json({
      success: true,
      data: {
        total: row.total || 0,
        credit: row.credit || 0,
        direct: row.direct || 0,
        uncategorized: row.uncategorized || 0,
        active: split.active || 0,
        inactive: split.inactive || 0
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
async function updateCustomerCategory(req, res, next) {
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

    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customer) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    }

    await db.prepare('UPDATE customers SET category = ? WHERE id = ?').run(category ?? null, id);
    const updated = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

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
/**
 * How many contacts go into one round trip.
 *
 * Sep 3, 2026. This constant is the whole reason this function was rewritten,
 * so it is worth writing down why it exists.
 *
 * Until today this function walked `contacts` one at a time, issuing a SELECT
 * and then an INSERT or UPDATE per contact. Under better-sqlite3 those were
 * synchronous in-process calls against a local file — microseconds each — so
 * 95,000 contacts cost a second or two and nobody ever noticed the shape.
 *
 * Against Supabase every one of those is a network round trip. A Full Resync
 * of the live org is 94,985 contacts, so the old loop was ~190,000 sequential
 * round trips. At the ~40-150ms Manila-to-Supabase latency this app actually
 * sees, that is somewhere between two and eight HOURS, spent entirely waiting.
 * And because it all ran inside one transaction, nothing was visible in the
 * Clients Directory for the whole of it — the directory read 0 clients while
 * the job looked frozen, which is exactly what it looked like from the UI.
 *
 * Batching turns those ~190,000 round trips into ~380 (one existence probe
 * and one upsert per batch). 500 rows x 7 bind parameters is 3,500 parameters
 * per statement, comfortably under Postgres' 65,535 limit, with room to raise
 * this if it is ever worth it.
 */
const RECONCILE_BATCH_SIZE = 500;

/**
 * @param {Array} contacts
 * @param {{ onProgress?: (written: number) => void }} [opts]
 *        Called after each batch commits its statement, with the running
 *        count of contacts written. The Full Resync job uses this to keep the
 *        progress bar moving through the write phase — without it the bar sits
 *        at the fetched-count and reads as a hang.
 */
async function reconcileContacts(contacts, opts = {}) {
  const { onProgress } = opts;

  let skipped = 0;

  // Normalise first, database second. This loop is pure CPU and touches
  // nothing remote, so it costs nothing to do it up front, and it makes the
  // batching below operate on plain rows instead of Zoho's response shape.
  const rows = [];
  for (const contact of contacts) {
    if (!contact.contact_id) { skipped++; continue; }

    // Sep 2, 2026: mirror Zoho's own contact status into `is_active`.
    //
    // Until then this was hard-coded to 1 on insert and never touched on
    // update, so every synced client read as active no matter what Zoho
    // said — and the MedRep order form, which filters on is_active, would
    // happily offer a contact Zoho has since deactivated and then have the
    // Sales Order rejected at submit with nothing on screen explaining
    // why. `products.is_active` has mirrored Zoho this way since Aug 27;
    // this brings customers in line.
    //
    // Only an explicit 'inactive' deactivates. A missing/unknown status
    // is treated as active, so a Zoho response that omits the field can
    // never mass-hide the directory.
    rows.push({
      zohoId: contact.contact_id,
      name: contact.contact_name || contact.company_name || 'Unnamed Zoho Contact',
      type: contact.customer_sub_type === 'business' ? 'credit' : 'direct',
      contactPerson: contact.first_name
        ? `${contact.first_name} ${contact.last_name || ''}`.trim()
        : null,
      phone: contact.phone || contact.mobile || null,
      address: contact.billing_address
        ? [contact.billing_address.address, contact.billing_address.city].filter(Boolean).join(', ')
        : null,
      isActive: String(contact.status || '').toLowerCase() === 'inactive' ? 0 : 1
    });
  }

  // Collapse duplicate contact_ids within one payload, last occurrence
  // winning — the same order the old per-row loop resolved them in, since
  // each pass overwrote the one before.
  //
  // This is not defensive padding: a single INSERT ... ON CONFLICT DO UPDATE
  // statement cannot touch the same row twice ("ON CONFLICT DO UPDATE command
  // cannot affect row a second time"), so a duplicate inside a batch would
  // abort the whole sync. The old loop tolerated duplicates silently; this
  // one has to remove them.
  const byZohoId = new Map();
  for (const r of rows) byZohoId.set(r.zohoId, r);
  const unique = [...byZohoId.values()];
  // Second and later occurrences counted as updates in the old loop, so they
  // still do here — these numbers are asserted by tests/customersSync.test.js
  // and shown to the user in the sync result message.
  const duplicateHits = rows.length - unique.length;

  let created = 0;
  let updated = 0;
  let written = 0;

  const txn = db.transaction(async () => {
    for (let i = 0; i < unique.length; i += RECONCILE_BATCH_SIZE) {
      const batch = unique.slice(i, i + RECONCILE_BATCH_SIZE);

      // One probe per batch to learn which of these already exist. The upsert
      // below would work without it, but `created` vs `updated` would then
      // have to be inferred from the `xmax = 0` trick, and an exact count from
      // an obvious query is worth one round trip per 500 rows.
      //
      // The array is wrapped in an extra array on purpose. db/pg.js's
      // flatten() preserves better-sqlite3's habit of accepting BOTH
      // `.all(a, b)` and `.all([a, b])`, so a bare `.all(ids)` would be read
      // as 500 separate parameters rather than one array-valued one. `[ids]`
      // is unambiguous: one parameter, which happens to be an array.
      const existingRows = await db
        .prepare('SELECT zoho_contact_id FROM customers WHERE zoho_contact_id = ANY(?)')
        .all([batch.map((r) => r.zohoId)]);
      const existing = new Set(existingRows.map((r) => r.zoho_contact_id));

      const params = [];
      const tuples = batch.map((r) => {
        params.push(r.name, r.type, r.zohoId, r.contactPerson, r.phone, r.address, r.isActive);
        return "(?, ?, ?, 'zoho', ?, ?, ?, datetime('now'), ?)";
      });

      // ON CONFLICT names the index predicate as well as the column because
      // idx_customers_zoho_contact_id is PARTIAL (... WHERE zoho_contact_id IS
      // NOT NULL). Postgres will not infer a partial index without it.
      //
      // `type` and `source` are deliberately absent from the DO UPDATE list.
      // Zoho has no equivalent of the credit-vs-direct distinction, so `type`
      // is only ever a guess on first insert that an admin then corrects
      // locally — re-deriving it on every sync would silently undo that
      // correction. This matches the old UPDATE statement, which set neither.
      await db
        .prepare(
          `INSERT INTO customers (name, type, zoho_contact_id, source, contact_person, contact_number, address, last_synced_at, is_active)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (zoho_contact_id) WHERE zoho_contact_id IS NOT NULL
           DO UPDATE SET
             name = EXCLUDED.name,
             contact_person = EXCLUDED.contact_person,
             contact_number = EXCLUDED.contact_number,
             address = EXCLUDED.address,
             is_active = EXCLUDED.is_active,
             last_synced_at = EXCLUDED.last_synced_at`
        )
        .run(...params);

      const newRows = batch.reduce((n, r) => n + (existing.has(r.zohoId) ? 0 : 1), 0);
      created += newRows;
      updated += batch.length - newRows;

      written += batch.length;
      if (onProgress) onProgress(written);
    }
  });
  await txn();

  return { created, updated: updated + duplicateHits, skipped };
}

async function syncFromZoho(req, res, next) {
  try {
    const result = await zoho.listContacts();
    const contacts = result.contacts || [];

    const { created, updated, skipped } = await reconcileContacts(contacts);

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

  // Sep 3, 2026: the job's `total` counts each contact TWICE — once for
  // fetching it from Zoho, once for writing it to the database.
  //
  // Before today the write phase reported no progress at all, because under
  // SQLite it was over before the frontend could poll it. Against Supabase it
  // is now the longer of the two phases, and a bar frozen at the fetched count
  // for minutes is indistinguishable from a crash — which is exactly how it
  // was read when the live Full Resync sat at "95002 found so far" while the
  // Clients Directory showed 0 clients.
  //
  // Counting fetch and write as equal halves of one bar keeps it monotonic:
  // 0-50% is the Zoho pull, 50-100% is the database write. The alternative —
  // resetting `processed` to zero when the write phase starts — makes the bar
  // jump backwards, which reads as a restart.
  if (mode === 'full') {
    const priorTotal = parseInt(await getSyncState('customers_last_full_total'), 10);
    if (priorTotal > 0) syncJobs.updateProgress(job.id, { total: priorTotal * 2 });
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
        const watermark = await getSyncState('customers_last_modified_watermark');
        if (watermark) opts.sinceWatermark = watermark;
      }

      const result = await zoho.listContacts({}, opts);
      const contacts = result.contacts || [];

      // The fetch is done, so the true count is known — replace the estimate
      // from the prior run with it, still doubled (see the comment above).
      const fetched = contacts.length;
      syncJobs.updateProgress(job.id, { processed: fetched, total: fetched * 2 });

      const { created, updated, skipped } = await reconcileContacts(contacts, {
        onProgress: (written) => syncJobs.updateProgress(job.id, { processed: fetched + written })
      });

      if (result.newWatermark) await setSyncState('customers_last_modified_watermark', result.newWatermark);
      if (mode === 'full') {
        await setSyncState('customers_last_full_sync_at', new Date().toISOString());
        await setSyncState('customers_last_full_total', contacts.length);
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
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
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

    await db.prepare(`
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
  ALLOWED_CATEGORIES,
  // Exposed for tests/reconcileBatch.verify.js, which measures the number of
  // queries a reconcile issues — the thing the Sep 3 batching rewrite exists
  // to change, and the one property the HTTP-level suites cannot see.
  __test__: { reconcileContacts }
};
