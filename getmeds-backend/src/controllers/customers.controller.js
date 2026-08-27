const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { isDryRunMode, getTestCustomerZohoId } = require('../services/zohoTestFlags');

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

    const testZohoId = getTestCustomerZohoId();
    res.json({
      success: true,
      data: {
        customers: customers.map((c) => ({
          ...c,
          is_test_customer: !!(testZohoId && c.zoho_contact_id === testZohoId)
        })),
        test_customer_gate_enabled: !!testZohoId,
        configured_test_zoho_contact_id: testZohoId,
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
async function syncFromZoho(req, res, next) {
  try {
    const result = await zoho.listContacts();
    const contacts = result.contacts || [];

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

    res.json({
      success: true,
      message: `Pulled ${contacts.length} contact(s) from Zoho — ${created} new, ${updated} refreshed` +
        (skipped ? `, ${skipped} skipped (no contact_id)` : '') +
        '. Nothing was written to Zoho.',
      data: { total_from_zoho: contacts.length, created, updated, skipped }
    });
  } catch (err) { next(err); }
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
  getZohoAddress,
  updateCustomerCategory,
  getCustomerStats,
  ALLOWED_CATEGORIES
};
