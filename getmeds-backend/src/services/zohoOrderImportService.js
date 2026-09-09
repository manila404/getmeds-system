const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { reconcileOrderFully, CONFIRMED_OR_BEYOND } = require('./zohoReconcileService');
const { getSyncState, setSyncState } = require('./syncState');

/**
 * Pull EVERY Sales Order that exists in Zoho into this app, and rebuild each
 * one's audit trail from Zoho's own record of it.
 *
 * Sep 9, 2026. Until now the flow only ran one way: this app created a Sales
 * Order, then webhooks and the reconcile poller kept the local row in step
 * with it. An order raised directly in Zoho — which is most of them — did not
 * exist here at all, so the Orders list was never the full picture and could
 * not be used to answer "what is happening with this customer's order" unless
 * somebody happened to have raised it through this app.
 *
 * This is the other direction, in bulk. scripts/import-zoho-orders.js already
 * did a five-at-a-time version of it as a dry-runnable CLI demo (Sep 1); this
 * is the same idea made complete, incremental, and reachable from a button.
 *
 * ── READ-ONLY TOWARD ZOHO ───────────────────────────────────────────────────
 * Three GETs and nothing else: listSalesOrders (the paginated walk),
 * getSalesOrder (per order, for line items and shipment/invoice detail) and
 * listSalesOrderComments (per order, for Zoho's own history log). The adapter
 * has no update, confirm, invoice, ship, void or delete method to call even by
 * accident — see ZohoAdapter.js. Every write this file makes is to the LOCAL
 * database.
 *
 * ── WHERE THE TRAIL COMES FROM ──────────────────────────────────────────────
 * Two different sources, deliberately kept distinct in the trail:
 *
 *   1. INFERRED checkpoints — reconcileOrderFully compares Zoho's current
 *      state against the local row and records what it can see (confirmed,
 *      invoice drafted/sent, packed, shipped, paid). This is the same code
 *      the webhooks and the background poller use, so an adopted order's
 *      milestones are recorded exactly the way a locally-raised order's are.
 *      What it cannot give is WHEN each of those happened, or by WHOM — only
 *      that they are true now.
 *
 *   2. ZOHO_LOG entries — Zoho's own "Comments & History" for the Sales
 *      Order, one local event per Zoho log entry, stamped with Zoho's
 *      timestamp and the person Zoho names. That is the half the inference
 *      cannot reconstruct, and it is why the trail on an imported order reads
 *      as a history rather than as a snapshot.
 *
 * Nothing here is invented. An event is either something Zoho reports as
 * currently true, or something Zoho's log says happened.
 */

/**
 * How many orders one run will fetch FULL DETAIL for.
 *
 * Read this together with the two-tier note in importSalesOrders. It caps the
 * expensive tier only — the per-order detail + history reads — never how many
 * Sales Orders are adopted. Every Sales Order Zoho has is adopted on every
 * full run; this is the budget for filling them in afterwards.
 *
 * A real ceiling, and low on purpose. Each order costs two Zoho GETs, and Zoho
 * Books enforces a per-minute rate limit and a daily call budget per org. This
 * org has 65,000+ Sales Orders, so enriching all of them is ~130,000 calls —
 * not something one button press can or should attempt. It is spread over
 * repeated runs, and over the on-demand refresh that already happens whenever
 * somebody opens an order.
 */
const IMPORT_MAX = Math.max(1, Number(process.env.ZOHO_SO_IMPORT_MAX) || 500);

/** Rows per batched INSERT/UPDATE. 500 x ~14 bind params stays far under Postgres' 65,535. */
const WRITE_BATCH_SIZE = 500;

/**
 * How many orders are fetched from Zoho at once.
 *
 * Kept deliberately small for the rate limit above. Three concurrent requests
 * is roughly 6 calls in flight per chunk (detail + comments), which keeps a
 * comfortable margin under Zoho's per-minute cap while still being ~3x faster
 * than a strictly serial walk over a Manila-to-Zoho round trip.
 */
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.ZOHO_SO_IMPORT_CONCURRENCY) || 3);

/** Orders per fetch-then-write chunk. Bounds peak memory; see importSalesOrders. */
const CHUNK_SIZE = 25;

/**
 * Zoho reports a comment's timestamp as a local date + a local clock time
 * ("2026-09-01" + "10:32 AM") with no offset attached — the org's timezone is
 * implied and never stated in the payload. Everything in order_events.created_at
 * is a UTC ISO string, so the two have to be reconciled somewhere.
 *
 * Defaulting to +08:00 because this org is Philippine (Asia/Manila, no DST, so
 * a fixed offset is exact rather than an approximation). Set
 * ZOHO_ORG_UTC_OFFSET if that ever stops being true. The raw `date`/`time`
 * strings are kept verbatim in each event's metadata regardless, so a wrong
 * offset here is a display-ordering annoyance, never lost information.
 */
const ORG_UTC_OFFSET = process.env.ZOHO_ORG_UTC_OFFSET || '+08:00';

/** The Zoho statuses that mean "this Sales Order no longer counts". */
const DEAD_SO_STATUSES = ['void', 'voided', 'cancelled', 'draft_deleted'];

/**
 * Adopted orders have no MedRep — nobody in this app raised them — but
 * orders.medrep_id is NOT NULL and references users(id). An admin is used,
 * and every adopted order says so in its intake notes and its first trail
 * entry, so nothing ever implies a rep submitted it.
 */
async function systemActor() {
  return (
    (await db
      .prepare("SELECT id, name FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1")
      .get()) || (await db.prepare('SELECT id, name FROM users ORDER BY id LIMIT 1').get())
  );
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * "2026-09-01" + "10:32 AM" -> "2026-09-01T02:32:00.000Z" (at +08:00).
 *
 * Returns null rather than guessing when the date is missing or unparseable,
 * so the caller can fall back to "now" explicitly instead of silently
 * inserting an epoch date that would sort the entry to the top of every trail.
 */
function zohoLogTimestamp(date, time) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) return null;

  let hours = 0;
  let minutes = 0;
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(String(time || '').trim());
  if (m) {
    hours = parseInt(m[1], 10) % 12;
    minutes = parseInt(m[2], 10);
    if (m[3] && m[3].toLowerCase() === 'pm') hours += 12;
    if (!m[3]) hours = parseInt(m[1], 10); // 24-hour clock, no meridiem
  }

  const stamp = `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${ORG_UTC_OFFSET}`;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Mirror one Sales Order's Zoho history log into order_events as ZOHO_LOG
 * entries.
 *
 * Idempotent by Zoho's own `comment_id`, recorded in each event's metadata:
 * re-importing an order adds only the log entries that have appeared since,
 * so this can be re-run as often as anyone likes without the trail growing a
 * duplicate copy of itself. Entries Zoho has no id for (it does happen on
 * older records) fall back to a hash of their content, which is stable for the
 * same reason.
 *
 * NEVER throws — a Sales Order whose history cannot be read still keeps the
 * inferred checkpoints reconcileOrderFully gave it. Returns how many new
 * entries were written, or null if the log could not be read at all.
 */
async function ingestSalesOrderLogs({ orderId, salesorderId, comments = null, source = 'zoho_import' }) {
  let log = comments;

  if (!log) {
    try {
      const res = await zoho.listSalesOrderComments(salesorderId);
      log = res?.comments || [];
    } catch (err) {
      console.warn(`[ZOHO_IMPORT] could not read history for Sales Order ${salesorderId}: ${err.message}`);
      return null;
    }
  }

  if (!log.length) return 0;

  // One read of what is already recorded, rather than one per log entry —
  // this runs for every imported order, and a per-entry probe would be
  // another network round trip each against a hosted database.
  const existingRows = await db
    .prepare("SELECT metadata FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_LOG'")
    .all(orderId);

  const seen = new Set();
  for (const row of existingRows) {
    try {
      const key = JSON.parse(row.metadata || '{}').zohoCommentId;
      if (key) seen.add(String(key));
    } catch (_) {
      // A malformed metadata blob is not a reason to refuse to import; the
      // worst case is one duplicated trail entry.
    }
  }

  const fresh = [];
  for (const entry of log) {
    const key = String(
      entry.comment_id || `${entry.date || ''}|${entry.time || ''}|${entry.description || ''}`
    );
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ entry, key });
  }

  if (!fresh.length) return 0;

  const insert = db.prepare(`
    INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
    VALUES (?, 'ZOHO_LOG', NULL, NULL, NULL, ?, ?, ?, ?)
  `);

  for (const { entry, key } of fresh) {
    // actor_id stays NULL on purpose: the person named here is a Zoho user,
    // and users(id) is this app's own table. Writing a local id would claim
    // an equivalence that does not exist. The NAME is what the trail shows.
    const actorName = entry.commented_by || 'Zoho';
    const notes = entry.description || '(no description)';
    await insert.run(
      orderId,
      actorName,
      notes,
      JSON.stringify({
        zohoCommentId: key,
        zohoCommentType: entry.comment_type || null,
        zohoOperationType: entry.operation_type || null,
        zohoDate: entry.date || null,
        zohoTime: entry.time || null,
        source
      }),
      zohoLogTimestamp(entry.date, entry.time) || new Date().toISOString()
    );
  }

  return fresh.length;
}

/**
 * The local customer row for a Zoho Sales Order's contact, creating a
 * placeholder if there isn't one.
 *
 * The CLI script this grew out of skipped any Sales Order whose contact was
 * not already in the local customers table, and told the operator to run the
 * customer sync first. That is fine for a five-order demo and wrong for a bulk
 * import: the two syncs are independent, an org's Sales Orders reference
 * contacts far outside whatever slice of 95,000 has been mirrored so far, and
 * "skip the order" loses the order over a detail the order itself carries.
 *
 * So a missing contact is created locally from what the Sales Order already
 * tells us, tagged source='zoho' with its zoho_contact_id, which is exactly
 * the shape the Clients Directory sync upserts on — the next Quick Sync fills
 * in the phone, address and active flag without creating a duplicate.
 *
 * `type` is a guess ('direct'), for the same reason it is a guess in the
 * customer sync: Zoho has no equivalent of the credit-vs-direct distinction,
 * and the Sales Order carries even less to go on than a contact record does.
 * The customer sync deliberately never overwrites `type` after insert, so an
 * admin's correction sticks.
 */
async function resolveCustomer(salesorder, cache) {
  const zohoContactId = salesorder.customer_id ? String(salesorder.customer_id) : null;
  const name = salesorder.customer_name || null;
  const cacheKey = zohoContactId || (name ? `name:${name.toLowerCase()}` : null);

  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);

  let customer = null;
  if (zohoContactId) {
    customer = await db.prepare('SELECT * FROM customers WHERE zoho_contact_id = ?').get(zohoContactId);
  }
  if (!customer && name) {
    customer = await db.prepare('SELECT * FROM customers WHERE LOWER(name) = LOWER(?) LIMIT 1').get(name);
  }

  if (!customer && (zohoContactId || name)) {
    const address =
      salesorder.shipping_address?.address || salesorder.billing_address?.address || null;
    const inserted = await db
      .prepare(
        `INSERT INTO customers (name, type, zoho_contact_id, source, address, last_synced_at, is_active)
         VALUES (?, 'direct', ?, 'zoho', ?, datetime('now'), 1)`
      )
      .run(name || 'Unnamed Zoho Contact', zohoContactId, address);
    customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(inserted.lastInsertRowid);
  }

  if (cacheKey && customer) cache.set(cacheKey, customer);
  return customer;
}

/**
 * Match a Zoho line item to a local product — by Zoho item id, then SKU, then
 * name. An unmatched line is NOT invented as a product: it is recorded in the
 * order's notes instead, and the order's total still comes from Zoho, so the
 * money on an adopted order is never a reconstruction.
 */
async function findLocalProduct(line, cache) {
  const keys = [
    line.item_id ? `id:${line.item_id}` : null,
    line.sku ? `sku:${String(line.sku).toLowerCase()}` : null,
    line.name ? `name:${String(line.name).toLowerCase()}` : null
  ].filter(Boolean);

  for (const key of keys) {
    if (cache.has(key)) return cache.get(key);
  }

  let product = null;
  if (line.item_id) {
    product = await db.prepare('SELECT * FROM products WHERE zoho_item_id = ?').get(String(line.item_id));
  }
  if (!product && line.sku) {
    product = await db.prepare('SELECT * FROM products WHERE LOWER(sku) = LOWER(?) LIMIT 1').get(line.sku);
  }
  if (!product && line.name) {
    product = await db.prepare('SELECT * FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1').get(line.name);
  }

  for (const key of keys) cache.set(key, product);
  return product;
}

/**
 * Find the local order a Zoho Sales Order belongs to, if any.
 *
 * Two ways in, in this order:
 *   1. zoho_so_id — the definitive link, set when this app created the SO or
 *      adopted it on an earlier run.
 *   2. reference_number — which createSalesOrder sets to the getmeds_order_id
 *      (see LiveZohoAdapter). This catches an order this app DID raise but
 *      whose zoho_so_id never got written back, e.g. the Zoho call succeeded
 *      and the response was lost. Matching on it re-links the pair instead of
 *      adopting a duplicate of an order already sitting in the Orders list.
 */
async function findLocalOrder(salesorder) {
  const byId = await db
    .prepare('SELECT * FROM orders WHERE zoho_so_id = ?')
    .get(String(salesorder.salesorder_id));
  if (byId) return { order: byId, matchedBy: 'zoho_so_id' };

  const ref = (salesorder.reference_number || '').trim();
  if (ref) {
    const byRef = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    if (byRef) return { order: byRef, matchedBy: 'reference_number' };
  }

  return { order: null, matchedBy: null };
}

/**
 * TIER 1 — adopt every Sales Order in `salesorders` from Zoho's LIST data
 * alone, in batches, with no per-order Zoho call and no per-order query.
 *
 * This is what makes "show me all 65,803" possible at all. The list walk has
 * already paid for this data; creating a row from it costs a handful of
 * batched INSERTs rather than two API calls and half a dozen round trips per
 * order. What the list does not carry — line items, invoices, packages,
 * history — is exactly what tier 2 fetches, within its budget.
 *
 * The row an adopted order gets here is honest about being a summary:
 *   - status comes from Zoho's own `status` and nothing else. Draft stays at
 *     'so_created'; anything past draft goes to 'ready_for_finance_verified',
 *     using the SAME list reconcileOrder uses (CONFIRMED_OR_BEYOND, imported
 *     rather than copied). Further stages — invoiced, packed, shipped — depend
 *     on the invoices/packages arrays, which only the detail call returns, so
 *     they are left to tier 2 rather than guessed at here.
 *   - delivery_address is 'See Zoho'. The list has no address at all, and the
 *     column is NOT NULL; tier 2 replaces it with the real one.
 *   - there are no order_items yet, and the total comes straight from Zoho, so
 *     the money on the order is right even while the lines are missing.
 */
async function adoptFromList(salesorders, known, actor) {
  const candidates = [];
  for (const so of salesorders) {
    if (!so.salesorder_id) continue;
    if (isKnown(so, known)) continue;
    // A Sales Order already void/cancelled that this app never saw is not
    // adopted — a local order created only to sit in 'cancelled' is a row
    // nobody asked for, for something this app was never part of.
    if (DEAD_SO_STATUSES.includes(String(so.status || '').toLowerCase())) continue;
    candidates.push(so);
  }

  if (!candidates.length) return { imported: 0, skipped: 0 };

  const customerIdByZohoContact = await resolveCustomersInBulk(candidates);

  const rows = [];
  let skipped = 0;
  const seenRef = new Set();

  for (const so of candidates) {
    const customerId = customerIdByZohoContact.get(String(so.customer_id));
    if (!customerId) { skipped++; continue; }

    const localRef = `ZOHO-${so.salesorder_number || so.salesorder_id}`;
    // Zoho can hold two Sales Orders with the same number in odd cases, and
    // getmeds_order_id is UNIQUE — a duplicate inside one batch would abort
    // the whole INSERT ("cannot affect row a second time"), so it is dropped
    // here rather than taking 500 good rows down with it.
    if (seenRef.has(localRef)) { skipped++; continue; }
    seenRef.add(localRef);

    const status = CONFIRMED_OR_BEYOND.includes(String(so.status || '').toLowerCase())
      ? 'ready_for_finance_verified'
      : 'so_created';
    const createdAt = so.created_time || (so.date ? `${so.date}T00:00:00.000Z` : new Date().toISOString());

    rows.push({
      localRef,
      customerId,
      status,
      total: Number(so.total ?? 0),
      date: so.date || createdAt.slice(0, 10),
      zohoSoId: String(so.salesorder_id),
      zohoSoNumber: so.salesorder_number || null,
      zohoSoStatus: so.status ? String(so.status).toLowerCase() : 'draft',
      salesperson: so.salesperson_name || null,
      createdAt,
      notes:
        `Adopted from Zoho Sales Order ${so.salesorder_number || so.salesorder_id}. Not raised in this app. ` +
        'Summary only so far — line items and Zoho history are pulled separately.'
    });
  }

  const now = new Date().toISOString();
  let imported = 0;

  for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
    const batch = rows.slice(i, i + WRITE_BATCH_SIZE);
    const params = [];
    const tuples = batch.map((r) => {
      params.push(
        r.localRef, r.customerId, actor.id, r.status, r.total, r.date,
        r.zohoSoId, r.zohoSoNumber, r.zohoSoStatus, r.salesperson,
        r.notes, r.createdAt, r.createdAt, now
      );
      // 17 columns; the literals are customer_type, delivery_address and
      // zoho_sync_status. Count the placeholders against the column list above
      // before touching this — one missing `?` silently shifts every value
      // after it into the wrong column.
      return "(?, ?, ?, ?, 'direct', ?, 'See Zoho', ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)";
    });

    // ON CONFLICT DO NOTHING rather than an upsert: a row that already exists
    // is one an earlier run adopted, and re-adopting it would overwrite
    // whatever tier 2 has since filled in with the thinner list version.
    const inserted = await db
      .prepare(
        `INSERT INTO orders (
           getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
           delivery_address, sales_order_date, zoho_so_id, zoho_so_number, zoho_so_status,
           salesperson, delivery_notes, zoho_sync_status, created_at, submitted_at, updated_at
         ) VALUES ${tuples.join(', ')}
         ON CONFLICT (getmeds_order_id) DO NOTHING`
      )
      .run(...params);
    imported += inserted.changes || 0;
  }

  await logAdoptionEvents(rows.map((r) => r.zohoSoId), actor);

  return { imported, skipped };
}

/**
 * One ORDER_IMPORTED_FROM_ZOHO entry per newly adopted order, batched.
 *
 * Written from a re-read of the orders just inserted rather than from the
 * insert's own output, because ON CONFLICT DO NOTHING gives no way to tell
 * which of a batch were new — and an order that already existed must not get a
 * second "imported" entry every time a full run passes over it. The
 * NOT EXISTS guard is what makes this idempotent.
 */
async function logAdoptionEvents(zohoSoIds, actor) {
  for (let i = 0; i < zohoSoIds.length; i += WRITE_BATCH_SIZE) {
    const batch = zohoSoIds.slice(i, i + WRITE_BATCH_SIZE);
    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
         SELECT o.id, 'ORDER_IMPORTED_FROM_ZOHO', NULL, o.status, ?, ?,
                'Imported from Zoho Sales Order ' || COALESCE(o.zoho_so_number, o.zoho_so_id) ||
                  '. This order was created in Zoho, not in this app.',
                NULL, o.created_at
           FROM orders o
          WHERE o.zoho_so_id = ANY(?)
            AND NOT EXISTS (
              SELECT 1 FROM order_events e
               WHERE e.order_id = o.id AND e.event_type = 'ORDER_IMPORTED_FROM_ZOHO'
            )`
      )
      // Bare `batch` — see the flatten() note in backfillSalespersonsFromList.
      .run(actor.id, `${actor.name} (Zoho import)`, batch);
  }
}

/**
 * Local customer ids for a batch of Sales Orders, creating rows for the Zoho
 * contacts this app has never seen.
 *
 * The per-order version of this (resolveCustomer) is two queries and possibly
 * an insert per order, which is fine for the handful tier 2 handles and
 * hopeless for 65,000. Same rules, done in batches: match on zoho_contact_id,
 * create what is missing tagged source='zoho' so the Clients Directory sync
 * upserts onto it later rather than duplicating it, and guess 'direct' for
 * `type` — which that sync deliberately never overwrites, so an admin's
 * correction sticks.
 */
async function resolveCustomersInBulk(salesorders) {
  const wanted = new Map(); // zoho_contact_id -> name
  for (const so of salesorders) {
    if (!so.customer_id) continue;
    const id = String(so.customer_id);
    if (!wanted.has(id)) wanted.set(id, so.customer_name || 'Unnamed Zoho Contact');
  }

  const found = new Map();
  const ids = [...wanted.keys()];

  for (let i = 0; i < ids.length; i += PROBE_BATCH_SIZE) {
    const batch = ids.slice(i, i + PROBE_BATCH_SIZE);
    const rows = await db
      .prepare('SELECT id, zoho_contact_id FROM customers WHERE zoho_contact_id = ANY(?)')
      .all([batch]);
    for (const r of rows) found.set(String(r.zoho_contact_id), r.id);
  }

  const missing = ids.filter((id) => !found.has(id));
  for (let i = 0; i < missing.length; i += WRITE_BATCH_SIZE) {
    const batch = missing.slice(i, i + WRITE_BATCH_SIZE);
    const params = [];
    const tuples = batch.map((id) => {
      params.push(wanted.get(id), id);
      return "(?, 'direct', ?, 'zoho', datetime('now'), 1)";
    });
    await db
      .prepare(
        `INSERT INTO customers (name, type, zoho_contact_id, source, last_synced_at, is_active)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (zoho_contact_id) WHERE zoho_contact_id IS NOT NULL DO NOTHING`
      )
      .run(...params);

    const rows = await db
      .prepare('SELECT id, zoho_contact_id FROM customers WHERE zoho_contact_id = ANY(?)')
      .all([batch]);
    for (const r of rows) found.set(String(r.zoho_contact_id), r.id);
  }

  return found;
}

/**
 * Which Sales Orders should get the expensive detail pull this run.
 *
 * Oldest-first among those with no detail yet, so repeated runs work steadily
 * through the backlog. Ordering in the DATABASE rather than in JS matters:
 * `salesorders` here is the whole org's list, and the answer has to be "which
 * of these does the database still lack detail for", which only the database
 * knows.
 */
async function selectForEnrichment(salesorders, limit) {
  const byZohoId = new Map();
  for (const so of salesorders) {
    if (so.salesorder_id) byZohoId.set(String(so.salesorder_id), so);
  }
  const ids = [...byZohoId.keys()];
  if (!ids.length) return [];

  const picked = [];
  for (let i = 0; i < ids.length && picked.length < limit; i += PROBE_BATCH_SIZE) {
    const rows = await db
      .prepare(
        `SELECT zoho_so_id FROM orders
          WHERE zoho_so_id = ANY(?) AND zoho_detail_synced_at IS NULL
          ORDER BY created_at ASC
          LIMIT ?`
      )
      // Bare, not wrapped — see the flatten() note in backfillSalespersonsFromList.
      .all(ids.slice(i, i + PROBE_BATCH_SIZE), limit - picked.length);
    for (const r of rows) {
      const so = byZohoId.get(String(r.zoho_so_id));
      if (so) picked.push(so);
    }
  }
  return picked;
}

/** How many orders in the whole database are still summary-only. */
async function countAwaitingDetail() {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL AND zoho_detail_synced_at IS NULL")
    .get();
  return row?.c || 0;
}

/**
 * Add the line items and real delivery address to an order adopted from the
 * list, now that its full detail has been fetched.
 *
 * Only ever ADDS: an order that already has items is left alone, because those
 * may have been edited here (see orders.controller.js's updateItems) and the
 * Zoho copy is not automatically the newer truth. The address is replaced only
 * while it is still the 'See Zoho' placeholder tier 1 wrote.
 */
async function addMissingLineItems(order, salesorder, productCache) {
  const existing = await db
    .prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?')
    .get(order.id);
  if (existing?.c) return;

  const lines = Array.isArray(salesorder.line_items) ? salesorder.line_items : [];
  if (!lines.length) return;

  const unmatched = [];
  for (const line of lines) {
    const product = await findLocalProduct(line, productCache);
    if (!product) { unmatched.push(line); continue; }
    const qty = Number(line.quantity) || 1;
    const rate = Number(line.rate) || 0;
    const subtotal = qty * rate;
    await db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(order.id, product.id, qty, rate, subtotal, Number(line.item_total ?? subtotal));
  }

  const address =
    salesorder.shipping_address?.address || salesorder.billing_address?.address || null;
  if (address && order.delivery_address === 'See Zoho') {
    await db.prepare('UPDATE orders SET delivery_address = ? WHERE id = ?').run(address, order.id);
  }

  if (unmatched.length) {
    await db
      .prepare(
        `UPDATE orders SET delivery_notes = COALESCE(delivery_notes, '') || ?
          WHERE id = ?`
      )
      .run(
        ` Line items with no local product match: ${unmatched.map((l) => `${l.name} x${l.quantity}`).join('; ')}.`,
        order.id
      );
  }
}

/**
 * Create the local row for a Sales Order that this app did not raise.
 *
 * Starts at 'so_created' and nothing further — every later stage is then
 * reconstructed by the ordinary reconcile, from Zoho. `getmeds_order_id` is
 * `ZOHO-<salesorder_number>` so an adopted order can never be mistaken for a
 * GM-/TestGM- one this app issued.
 */
async function adoptSalesOrder({ salesorder, customer, actor, productCache }) {
  const localRef = `ZOHO-${salesorder.salesorder_number || salesorder.salesorder_id}`;
  const total = Number(salesorder.total ?? 0);
  const address =
    salesorder.shipping_address?.address ||
    salesorder.billing_address?.address ||
    customer.address ||
    'See Zoho';

  const lines = Array.isArray(salesorder.line_items) ? salesorder.line_items : [];
  const matched = [];
  const unmatched = [];
  for (const line of lines) {
    const product = await findLocalProduct(line, productCache);
    if (product) matched.push({ line, product });
    else unmatched.push(line);
  }

  const notes = [`Adopted from Zoho Sales Order ${salesorder.salesorder_number || salesorder.salesorder_id}. Not raised in this app.`];
  if (unmatched.length) {
    notes.push(
      `Line items with no local product match: ${unmatched
        .map((l) => `${l.name} x${l.quantity}`)
        .join('; ')}.`
    );
  }

  const now = new Date().toISOString();
  // Zoho's own creation timestamp where it has one, so an adopted order sorts
  // into the Orders list where it actually belongs rather than all of them
  // landing together at the moment of the import.
  const createdAt = salesorder.created_time || (salesorder.date ? `${salesorder.date}T00:00:00.000Z` : now);

  let orderId = null;
  await db.transaction(async () => {
    const inserted = await db
      .prepare(
        `INSERT INTO orders (
           getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
           delivery_address, delivery_notes, sales_order_date,
           zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status,
           created_at, submitted_at, updated_at, salesperson
         ) VALUES (?, ?, ?, 'so_created', ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`
      )
      .run(
        localRef,
        customer.id,
        actor.id,
        customer.type === 'credit' ? 'credit' : 'direct',
        total,
        address,
        notes.join(' '),
        salesorder.date || createdAt.slice(0, 10),
        String(salesorder.salesorder_id),
        salesorder.salesorder_number || null,
        salesorder.status ? String(salesorder.status).toLowerCase() : 'draft',
        createdAt,
        createdAt,
        now,
        // Sep 9, 2026: Zoho's Salesperson, stored ON the order.
        //
        // For an order raised here, orders.salesperson is normally NULL and
        // means "use the ordering MedRep's account value" — the reader joins
        // through users to get it. An adopted order has no such account to
        // join to: its medrep_id is the system actor that owns every import,
        // so joining would name whichever admin happened to run it (which is
        // exactly why the dashboard showed one person against 466 orders).
        // The Sales Order itself carries the real answer, in the same
        // "<division> | <display name>" form this app already uses, so it is
        // recorded here rather than inferred from something that isn't true.
        salesorder.salesperson_name || null
      );
    // Created from the full detail, so it is not summary-only even for a
    // moment — unlike a row adopted by tier 1, which is.
    await db
      .prepare('UPDATE orders SET zoho_detail_synced_at = ? WHERE getmeds_order_id = ?')
      .run(now, localRef);
    orderId = inserted.lastInsertRowid;

    for (const { line, product } of matched) {
      const qty = Number(line.quantity) || 1;
      const rate = Number(line.rate) || 0;
      const subtotal = qty * rate;
      await db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, line_total)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(orderId, product.id, qty, rate, subtotal, Number(line.item_total ?? subtotal));
    }

    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
         VALUES (?, 'ORDER_IMPORTED_FROM_ZOHO', NULL, 'so_created', ?, ?, ?, ?, ?)`
      )
      .run(
        orderId,
        actor.id,
        `${actor.name} (Zoho import)`,
        `Imported from Zoho Sales Order ${salesorder.salesorder_number || salesorder.salesorder_id}. ` +
          'This order was created in Zoho, not in this app.',
        JSON.stringify({
          zohoSoId: String(salesorder.salesorder_id),
          zohoSoNumber: salesorder.salesorder_number || null,
          unmatchedLineItems: unmatched.length,
          source: 'zoho_import'
        }),
        createdAt
      );
  })();

  return { orderId, localRef, unmatchedLines: unmatched.length };
}

/**
 * Re-link a local order to its Zoho Sales Order when the id was never stored.
 * Only ever fills a blank — an existing zoho_so_id is left alone, since a
 * disagreement there is a real problem to look at, not something to overwrite
 * silently during a bulk import.
 */
async function linkExistingOrder(order, salesorder) {
  if (order.zoho_so_id) return false;

  await db
    .prepare(
      `UPDATE orders SET zoho_so_id = ?, zoho_so_number = COALESCE(?, zoho_so_number),
         zoho_sync_status = 'synced', updated_at = ? WHERE id = ?`
    )
    .run(String(salesorder.salesorder_id), salesorder.salesorder_number || null, new Date().toISOString(), order.id);

  await db
    .prepare(
      `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
       VALUES (?, 'ZOHO_SO_LINKED', ?, ?, NULL, 'Zoho Import', ?, ?, ?)`
    )
    .run(
      order.id,
      order.status,
      order.status,
      `Matched to Zoho Sales Order ${salesorder.salesorder_number || salesorder.salesorder_id} by reference number — ` +
        'this order was raised here but its Zoho Sales Order id had never been recorded.',
      JSON.stringify({ zohoSoId: String(salesorder.salesorder_id), source: 'zoho_import' }),
      new Date().toISOString()
    );

  return true;
}

/**
 * Import every Sales Order Zoho has (up to IMPORT_MAX), and build each one's
 * trail.
 *
 * @param {'quick'|'full'} mode
 *   'full'  — walk the org's Sales Orders in created_time order.
 *   'quick' — only the ones created or edited since the last run's watermark
 *             (services/syncState.js). The first run ever has no watermark, so
 *             it behaves as a full pull to establish one.
 * @param {{ onFetched?: (n:number) => void, onProgress?: (done:number, total:number) => void }} hooks
 *   Progress reporting for the background job; see controllers/orders.controller.js.
 * @param {number} [detailLimit]
 *   How many orders to pull full detail for this run. Defaults to IMPORT_MAX;
 *   overridable so a caller can take a smaller bite (and so a test can prove
 *   that adoption is NOT bounded by it).
 * @returns {Promise<object>} a summary — never throws for a single bad order.
 */
async function importSalesOrders({ mode = 'full', onFetched, onProgress, detailLimit } = {}) {
  const budget = Math.max(0, Number.isFinite(detailLimit) ? detailLimit : IMPORT_MAX);
  const actor = await systemActor();
  if (!actor) {
    throw new Error('No users exist in this database, so an imported order would have no owner to record.');
  }

  const listOpts = {};
  if (onFetched) {
    listOpts.onPage = ({ processed }) => onFetched(processed);
  }
  if (mode === 'quick') {
    const watermark = await getSyncState('salesorders_last_modified_watermark');
    if (watermark) listOpts.sinceWatermark = watermark;
  }

  const listed = await zoho.listSalesOrders({}, listOpts);
  const all = listed.salesorders || [];

  // What does this app already know about these Sales Orders? One batched
  // probe rather than a lookup per order — at 65,000 Sales Orders over a
  // Manila-to-Supabase round trip, per-order probes are hours of pure waiting
  // before the first useful call is made.
  const known = await loadKnownOrders(all);

  // A free pass, before anything is spent on the detail budget: Zoho's LIST
  // response already carries salesperson_name, so an adopted order missing it
  // can be filled in without a single extra API call. This is what repairs
  // orders imported before Sep 9, when the Salesperson was not being recorded.
  const salespersonsBackfilled = await backfillSalespersonsFromList(all, known);

  // Re-link before adopting — see linkUnlinkedFromList for why the order of
  // these two matters.
  const linkedFromList = mode === 'quick' ? 0 : await linkUnlinkedFromList(all, known);

  // ── TIER 1: adopt EVERY Sales Order, from the list alone ──────────────────
  //
  // The list walk has already fetched all of them — one call per 200 orders —
  // and what it returns is enough to create a real order row: Sales Order
  // number, customer, total, date, salesperson, and Zoho's status. So every
  // Sales Order the org has ends up in the Orders list on a full run, however
  // many there are. Only line items and Zoho's history log are missing, and
  // those are what tier 2 fills in.
  //
  // This replaces adopting one order at a time behind the detail budget, which
  // was the first version and could never show more than the budget's worth:
  // 500 of 65,803, with no way to reach the rest however often the button was
  // pressed.
  const adoption =
    mode === 'quick' ? { imported: 0, skipped: 0 } : await adoptFromList(all, known, actor);

  // ── TIER 2: fill in the detail, within the budget ─────────────────────────
  //
  // Which orders are worth spending two Zoho GETs on:
  //
  //   full  — the ones with no detail yet (zoho_detail_synced_at IS NULL),
  //           oldest first so repeated runs work steadily through the backlog
  //           instead of re-taking the same slice.
  //   quick — everything the watermark walk returned, because that walk only
  //           returns what changed in Zoho, and a changed order is worth
  //           re-reading whether or not its detail is already here.
  const work = mode === 'quick' ? all : await selectForEnrichment(all, budget);

  const salesorders = work.slice(0, budget);
  const cappedBy = work.length > budget ? work.length - budget : 0;
  const awaitingDetail = mode === 'quick' ? 0 : await countAwaitingDetail();

  const summary = {
    mode,
    total_from_zoho: all.length,
    // Tier 1: rows created this run from list data alone.
    imported: adoption.imported,
    // Tier 2: how many had their full detail pulled this run, and how many
    // across the whole database are still summary-only.
    detailed: salesorders.length,
    awaiting_detail: Math.max(0, awaitingDetail - salesorders.length),
    needs_work: work.length,
    considered: salesorders.length,
    linked: linkedFromList,
    salespersons_backfilled: salespersonsBackfilled,
    already_present: 0,
    skipped: adoption.skipped,
    log_entries: 0,
    checkpoints: 0,
    failed: 0,
    failures: [],
    capped_at: cappedBy ? budget : null,
    remaining: cappedBy,
    truncated: !!listed.truncated || cappedBy > 0,
    stopped_early: !!listed.stoppedEarly
  };

  const customerCache = new Map();
  const productCache = new Map();
  let processed = 0;

  // Chunked fetch-then-write rather than fetch-everything-then-write-everything:
  // it bounds how much Zoho detail is held in memory at once, and it means a
  // run that dies halfway has still committed everything up to that point
  // instead of losing all of it.
  for (let i = 0; i < salesorders.length; i += CHUNK_SIZE) {
    const chunk = salesorders.slice(i, i + CHUNK_SIZE);

    const fetched = await mapWithConcurrency(chunk, FETCH_CONCURRENCY, async (summaryRecord) => {
      const id = summaryRecord.salesorder_id;
      const out = { id, salesorder: summaryRecord, comments: null, error: null };
      try {
        const detail = await zoho.getSalesOrder(id);
        if (detail?.salesorder) out.salesorder = detail.salesorder;
      } catch (err) {
        out.error = err;
        return out;
      }
      try {
        const log = await zoho.listSalesOrderComments(id);
        out.comments = log?.comments || [];
      } catch (err) {
        // The history is the nice-to-have half. Losing it costs the WHEN and
        // WHO of the trail, not the order itself, so the import continues
        // with the inferred checkpoints alone.
        out.comments = null;
      }
      return out;
    });

    for (const item of fetched) {
      processed++;
      if (onProgress) onProgress(processed, salesorders.length);

      if (item.error) {
        summary.failed++;
        if (summary.failures.length < 20) {
          summary.failures.push({ salesorder_id: item.id, message: item.error.message });
        }
        continue;
      }

      try {
        await importOne({ salesorder: item.salesorder, comments: item.comments, actor, customerCache, productCache, summary });
      } catch (err) {
        console.error(`[ZOHO_IMPORT] Sales Order ${item.id} failed:`, err);
        summary.failed++;
        if (summary.failures.length < 20) {
          summary.failures.push({ salesorder_id: item.id, message: err.message });
        }
      }
    }
  }

  if (listed.newWatermark) await setSyncState('salesorders_last_modified_watermark', listed.newWatermark);
  if (mode === 'full') {
    await setSyncState('salesorders_last_full_sync_at', new Date().toISOString());
    await setSyncState('salesorders_last_full_total', all.length);
  }

  return summary;
}

/** How many ids go into one batched probe. Same reasoning as reconcileContacts. */
const PROBE_BATCH_SIZE = 500;

/**
 * One batched read of the local orders these Zoho Sales Orders correspond to.
 *
 * Keyed both ways the import matches (see findLocalOrder): by zoho_so_id, and
 * by getmeds_order_id against the Sales Order's reference_number. Returns the
 * rows themselves rather than a bare set of ids, because the caller needs
 * `salesperson` off them for the free backfill below.
 *
 * The array is wrapped in an extra array on purpose — db/pg.js's flatten()
 * keeps better-sqlite3's habit of accepting both `.all(a, b)` and `.all([a,
 * b])`, so a bare `.all(ids)` would be read as 500 separate parameters rather
 * than one array-valued one.
 */
async function loadKnownOrders(salesorders) {
  const byZohoId = new Map();
  const byRef = new Map();
  const COLUMNS = 'SELECT id, zoho_so_id, getmeds_order_id, salesperson FROM orders';

  const ids = [...new Set(salesorders.map((so) => String(so.salesorder_id)).filter(Boolean))];
  for (let i = 0; i < ids.length; i += PROBE_BATCH_SIZE) {
    const rows = await db
      .prepare(COLUMNS + ' WHERE zoho_so_id = ANY(?)')
      .all([ids.slice(i, i + PROBE_BATCH_SIZE)]);
    for (const r of rows) byZohoId.set(String(r.zoho_so_id), r);
  }

  const refs = [...new Set(salesorders.map((so) => (so.reference_number || '').trim()).filter(Boolean))];
  for (let i = 0; i < refs.length; i += PROBE_BATCH_SIZE) {
    const rows = await db
      .prepare(COLUMNS + ' WHERE getmeds_order_id = ANY(?)')
      .all([refs.slice(i, i + PROBE_BATCH_SIZE)]);
    for (const r of rows) byRef.set(r.getmeds_order_id, r);
  }

  return { byZohoId, byRef };
}

/**
 * Does this app already have an order for this Sales Order — by either route
 * findLocalOrder matches on?
 *
 * Used to decide what NOT to adopt. Matching by reference_number counts even
 * when the local row has no zoho_so_id yet: that row is an order this app
 * raised, and adopting a second ZOHO- copy of it would be the worst possible
 * outcome. Re-linking the pair instead is handled by linkUnlinkedFromList,
 * which runs BEFORE adoption for exactly this reason.
 */
function isKnown(salesorder, known) {
  if (known.byZohoId.has(String(salesorder.salesorder_id))) return true;
  const ref = (salesorder.reference_number || '').trim();
  return !!(ref && known.byRef.has(ref));
}

/**
 * Re-link orders this app raised whose Zoho Sales Order id was never recorded
 * — the shape you get when the create call succeeded and its response was lost.
 *
 * Runs before adoption, and must: adoption skips anything matched by reference
 * number (see isKnown), so without this such an order would simply be passed
 * over forever, its Zoho record sitting there unmatched. Rare by nature — a
 * lost response, not a routine occurrence — so a per-order loop is right here.
 *
 * Only ever fills a blank. An existing zoho_so_id that disagrees is a real
 * problem to look at, not something to overwrite silently during a bulk import.
 */
async function linkUnlinkedFromList(salesorders, known) {
  let linked = 0;

  for (const so of salesorders) {
    const ref = (so.reference_number || '').trim();
    if (!ref) continue;
    if (known.byZohoId.has(String(so.salesorder_id))) continue;

    const row = known.byRef.get(ref);
    if (!row || row.zoho_so_id) continue;

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id);
    if (!order) continue;
    if (!(await linkExistingOrder(order, so))) continue;

    // Keep the cached view honest so adoption below, and the enrichment
    // selection after it, both see this Sales Order as known and linked.
    row.zoho_so_id = String(so.salesorder_id);
    known.byZohoId.set(String(so.salesorder_id), row);
    linked++;
  }

  return linked;
}

/**
 * Fill in the Salesperson on adopted orders straight from the LIST response,
 * with no per-order Zoho call at all.
 *
 * Zoho's List Sales Orders response carries salesperson_name, so this costs
 * nothing beyond the walk that already happened — which matters, because the
 * orders needing it are precisely the ones already imported, and re-fetching
 * each one's detail to read a field the list already gave us would spend the
 * whole per-run budget re-learning what we have.
 *
 * Grouped by name so the writes are a handful of statements rather than one
 * per order: an org has a few dozen salespeople and thousands of orders.
 */
async function backfillSalespersonsFromList(salesorders, known) {
  const idsByName = new Map();

  for (const so of salesorders) {
    const name = so.salesperson_name;
    if (!name) continue;
    const row = known.byZohoId.get(String(so.salesorder_id));
    if (!row || row.salesperson) continue;
    // Adopted orders only — see backfillSalesperson below for why a blank on a
    // locally-raised order is meaningful and must not be filled in.
    if (!String(row.getmeds_order_id || '').startsWith('ZOHO-')) continue;

    if (!idsByName.has(name)) idsByName.set(name, []);
    idsByName.get(name).push(row.id);
    row.salesperson = name; // keep the cached row honest for later passes
  }

  let updated = 0;
  for (const [name, ids] of idsByName) {
    for (let i = 0; i < ids.length; i += PROBE_BATCH_SIZE) {
      const batch = ids.slice(i, i + PROBE_BATCH_SIZE);
      // `batch` bare, not `[batch]`: db/pg.js's flatten() only unwraps the
      // extra array when it is the single argument, and there is a `name`
      // alongside it here — wrapped, Postgres would receive a 2-D array.
      await db.prepare('UPDATE orders SET salesperson = ? WHERE id = ANY(?)').run(name, batch);
      updated += batch.length;
    }
  }

  return updated;
}

/**
 * Fill in the Salesperson on ONE adopted order, from its full detail.
 *
 * Scoped to adopted orders on purpose. On an order this app raised, a NULL
 * orders.salesperson is meaningful — it means "whatever the ordering MedRep's
 * account says", which the reader resolves by joining users — and writing
 * Zoho's copy of that same value into the column would turn an implicit answer
 * into a hard-coded one that stops tracking the account. An adopted order has
 * no such account behind it, so there is nothing to overwrite and nothing to
 * keep tracking.
 *
 * Only ever fills a blank; an existing value is left alone.
 */
async function backfillSalesperson(order, salesorder, summary) {
  const name = salesorder.salesperson_name;
  if (!name) return;
  if (order.salesperson) return;
  if (!String(order.getmeds_order_id || '').startsWith('ZOHO-')) return;

  await db.prepare('UPDATE orders SET salesperson = ? WHERE id = ?').run(name, order.id);
  if (summary) summary.salespersons_backfilled = (summary.salespersons_backfilled || 0) + 1;
}

/**
 * TIER 2 for one Sales Order: make sure it has a local order, fill in its line
 * items, reconcile it against Zoho, and mirror Zoho's history into its trail.
 *
 * The adopt branch below is still here even though tier 1 normally creates the
 * row first: quick mode skips tier 1 entirely (its watermark walk returns only
 * what changed, which is not a basis for adopting), so an order changed in Zoho
 * that this app has never seen still needs creating here.
 */
async function importOne({ salesorder, comments, actor, customerCache, productCache, summary }) {
  const { order: existing, matchedBy } = await findLocalOrder(salesorder);
  let orderId;

  if (existing) {
    orderId = existing.id;
    if (matchedBy === 'reference_number' && (await linkExistingOrder(existing, salesorder))) {
      summary.linked++;
    } else {
      summary.already_present++;
    }
    await backfillSalesperson(existing, salesorder, summary);
    await addMissingLineItems(existing, salesorder, productCache);
  } else {
    // A Sales Order that is already void/cancelled and was never known here is
    // not adopted: creating a local order at 'so_created' purely to move it
    // straight to 'cancelled' adds a row nobody asked for to the Orders list,
    // for something that never involved this app at any point.
    const status = String(salesorder.status || '').toLowerCase();
    if (DEAD_SO_STATUSES.includes(status)) {
      summary.skipped++;
      return;
    }

    const customer = await resolveCustomer(salesorder, customerCache);
    if (!customer) {
      summary.skipped++;
      return;
    }

    const adopted = await adoptSalesOrder({ salesorder, customer, actor, productCache });
    orderId = adopted.orderId;
    summary.imported++;
  }

  // The inferred checkpoints — confirmed, invoiced, packed, shipped, paid.
  // Re-uses the detail already fetched above rather than making up to seven
  // more GETs per order; see reconcileOrder's `salesorder` parameter.
  const result = await reconcileOrderFully({
    orderId,
    actorId: actor.id,
    actorName: `${actor.name} (Zoho import)`,
    source: 'zoho_import',
    salesorder
  });
  summary.checkpoints += result.actions?.length || 0;

  // Zoho's own history — the WHEN and WHO the inference cannot give.
  const written = await ingestSalesOrderLogs({
    orderId,
    salesorderId: salesorder.salesorder_id,
    comments
  });
  if (written) summary.log_entries += written;

  // This order is no longer summary-only. Stamped last, after the detail has
  // actually landed, so a run that dies partway leaves the orders it did not
  // reach still marked as needing detail rather than silently written off.
  await db
    .prepare('UPDATE orders SET zoho_detail_synced_at = ? WHERE id = ?')
    .run(new Date().toISOString(), orderId);
}

module.exports = {
  importSalesOrders,
  ingestSalesOrderLogs,
  // Exported for scripts/import-zoho-orders.js's dry run, which needs to say
  // what WOULD happen to each Sales Order without writing anything.
  findLocalOrder,
  IMPORT_MAX
};
