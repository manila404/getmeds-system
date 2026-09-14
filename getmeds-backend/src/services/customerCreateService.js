'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
// Sep 11, 2026: releasing orders held on a pending customer. Required lazily
// inside the function — zohoRetryService requires this module's siblings, and
// a top-level require here closes a cycle that leaves one of them undefined.
const { buildZohoSalesOrderPayload } = require('./zohoPayloadBuilder');

/**
 * Creating a customer that does not exist yet, from the order form.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Sep 11, 2026. A MedRep taking an order from a customer Zoho has never seen
 * had nowhere to go. The order form can only pick an existing contact,
 * createSalesOrder requires a `zoho_customer_id`, and getting one meant asking
 * somebody with Zoho access and waiting. The order simply did not get placed.
 *
 * ── IT REFUSES BEFORE IT ASKS ZOHO ──────────────────────────────────────────
 *
 * Confirmed with the business: a likely duplicate BLOCKS, and the existing
 * customer is offered to pick instead.
 *
 * That is not only kindness to the user. Two of these fields are enforced by
 * Zoho itself, and its refusals are unhelpful in different ways:
 *
 *   cf_lto_license_number is UNIQUE in this org. A second contact carrying
 *   the same licence is rejected with a message naming the field, not the
 *   contact that already holds it -- so a rep sees "already exists" with no
 *   way to find out who, and the useful answer (that pharmacy is already in
 *   Zoho, pick it) is exactly what they needed.
 *
 *   contact_name duplicates are NOT rejected. Zoho will happily hold three
 *   contacts called "Mercury Drug Taft", and nobody finds out until someone
 *   is reconciling invoices. Silence is the worse failure here, so this is
 *   the check that matters most and the one Zoho will never make for us.
 *
 * ── THE ORDER OF WRITES ─────────────────────────────────────────────────────
 *
 * Zoho first, local second. If the local insert fails, the contact exists in
 * Zoho and the next customer sync adopts it -- recoverable, and a duplicate is
 * avoided because the next attempt finds it by name.
 *
 * The other order would be worse: a local row with no `zoho_contact_id` is a
 * customer that looks selectable and fails at the first Sales Order, which is
 * the failure this whole feature exists to remove.
 */

/**
 * The local classification, mirroring customers.controller.js's list.
 *
 * Sep 11, 2026: confirmed with the business that this means "hospital order
 * rules apply" — 'hospital' is what makes the order form demand a GL Number, a
 * receiver type, and four attachments (Guarantee Letter, Prescription, Proof
 * of Payment, Valid ID).
 *
 * Which makes a NULL here consequential rather than untidy. Every one of the
 * 95,063 customers in this database is uncategorised, so that rule has never
 * fired for anybody; a customer created without one silently joins them, and
 * four required controls are skipped with nothing on screen to say so.
 */
const CATEGORIES = ['doctor', 'hospital', 'distributor', 'pwd'];

/**
 * Did Zoho refuse because of something about THIS customer, or because Zoho
 * could not be reached at all?
 *
 * Sep 11, 2026. This lived in two places — createCustomer had the full list,
 * syncHeldCustomer had only the original "missing scope" test — and they
 * drifted exactly as duplicated judgements do. The visible result: a held
 * customer pushed while the token was rate-limited got marked `failed`
 * ("Needs attention") rather than staying `pending`, which told an admin to go
 * and fix a customer that had nothing wrong with it.
 *
 * The distinction is the whole design:
 *
 *   unreachable  a missing scope, an expired or throttled token, DNS, a
 *                dropped connection. Says nothing about the customer, clears
 *                by itself, so KEEP the work and try again later.
 *
 *   refused      a duplicate LTO licence, a malformed field. Will not fix
 *                itself, so stop retrying and put it in front of a human.
 */
function isZohoUnreachable(message) {
  const m = String(message || '');
  return (
    /not authorized|unauthorized|invalid.*scope/i.test(m) ||
    /access denied|too many requests|rate limit/i.test(m) ||
    /refresh .*token|invalid_code|invalid_client|expired/i.test(m) ||
    /ENOTFOUND|ECONNRESET|ETIMEDOUT|network|fetch failed|socket hang up/i.test(m)
  );
}

/** Comparison form for names: case, spacing and punctuation are not identity. */
function normalise(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.,''`-]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Customers already here that look like the one being created.
 *
 * Local only. The customers table is kept in step with Zoho by the existing
 * sync (see customers.controller.js), so it can answer this without a Zoho
 * round trip on every keystroke of a form.
 */
async function findDuplicates({ display_name: displayName, lto_license_number: lto }) {
  const hits = [];

  // Sep 11, 2026: the WHOLE row, not a summary of it.
  //
  // A duplicate is handed to the order form to be selected, and the form reads
  // more off a customer than a name — `category` decides whether the hospital
  // rules apply (GL Number, receiver type, four attachments), and `is_active`
  // decides whether it can be picked at all. A slim projection made a hospital
  // customer chosen from the duplicate list behave like an ordinary one, with
  // nothing on screen to suggest anything had been skipped.
  const name = normalise(displayName);
  if (name) {
    const rows = await db
      .prepare(
        `SELECT * FROM customers
          WHERE lower(trim(name)) = ?
          LIMIT 5`
      )
      .all(String(displayName).trim().toLowerCase());
    for (const r of rows) hits.push({ ...r, matched_on: 'name' });
  }

  const licence = String(lto || '').trim();
  if (licence) {
    const rows = await db
      .prepare(
        `SELECT * FROM customers
          WHERE lto_license_number IS NOT NULL
            AND lower(trim(lto_license_number)) = ?
          LIMIT 5`
      )
      .all(licence.toLowerCase());
    for (const r of rows) {
      // A row can match on both; report it once, by the stronger reason.
      const already = hits.find((h) => h.id === r.id);
      if (already) already.matched_on = 'name_and_licence';
      else hits.push({ ...r, matched_on: 'licence' });
    }
  }

  return hits;
}

// ── Is a WAITING customer already in Zoho? ──────────────────────────────────
//
// Sep 14, 2026. findDuplicates above runs when a customer is created, and only
// on an exact name or licence. Two gaps let a duplicate through to the queue:
// the customer is created in Zoho by hand while the local one waits, or the
// names differ by a letter. 1ST SPECIALITY PHARMA waited here while someone
// created "1ST SPECIALTY PHARMA" directly in Zoho and raised two Sales Orders
// against it; pushing the waiting one would have put the same business in
// Zoho twice.
//
// So every push first compares the waiting customer with the customers Zoho
// already has (the local copy, kept current by the customer pull), on more
// than the name, and a likely match is held back for a person to decide:
// use the Zoho customer, push as new anyway, or delete the waiting one.

/** Letters and digits only: "1ST SPECIALITY PHARMA" -> "1stspecialitypharma". */
const compact = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
/** The name's words long enough to mean something — "1st", "of", "co" are not. */
const nameWords = (v) => normalise(v).split(' ').map(compact).filter((w) => w.length >= 4);

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How alike two names are, for "is this the same business".
 *   'same_name'     identical once case, spacing and punctuation are ignored
 *   'similar_name'  a letter or two apart (SPECIALITY / SPECIALTY), or one
 *                   name's words all inside the other's ("Mercury Drug Taft" /
 *                   "Mercury Drug Taft Branch")
 */
function compareNames(a, b) {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return null;
  if (x === y) return 'same_name';
  // Numbers are identity, not spelling: "Branch 12" and "Branch 13" are one
  // letter apart and two different customers.
  if (digitsOf(a) !== digitsOf(b)) return null;
  if (Math.min(x.length, y.length) >= 6 && 1 - editDistance(x, y) / Math.max(x.length, y.length) >= 0.85) {
    return 'similar_name';
  }
  const wa = nameWords(a);
  const wb = nameWords(b);
  const within = (small, big) => small.length >= 2 && small.every((w) => big.includes(w));
  if (within(wa, wb) || within(wb, wa)) return 'similar_name';
  return null;
}

// Strongest evidence first. A licence or TIN is one business; a phone can be a
// shared switchboard, so on its own it only asks the question.
const MATCH_WEIGHT = { lto: 5, tin: 5, same_name: 4, email: 3, similar_name: 3, phone: 2 };
// More Zoho customers than this on one phone number and it is not evidence.
// Production has 09123456789 on five unrelated customers.
const MAX_SHARED_PHONE = 3;

/**
 * Customers Zoho already has that look like this waiting one. Never the
 * waiting customer itself, never another local-only one — only rows with a
 * zoho_contact_id, because "use the existing customer" has to mean one Zoho
 * actually holds.
 */
async function findZohoMatches(held) {
  const found = new Map();
  const add = (row, reason) => {
    if (!row || row.id === held.id) return;
    const entry = found.get(row.id) || { row, matched: new Set() };
    entry.matched.add(reason);
    found.set(row.id, entry);
  };
  const base = 'SELECT * FROM customers WHERE zoho_contact_id IS NOT NULL AND id <> ?';

  // Name. The LIKE narrows 95,000 rows to the few sharing every meaningful
  // word's first letters; compareNames decides.
  const words = nameWords(held.name);
  const nameRows = words.length
    ? await db
        .prepare(`${base} AND ${words.map(() => 'lower(name) LIKE ?').join(' AND ')} LIMIT 500`)
        .all(held.id, ...words.map((w) => `%${w.slice(0, 4)}%`))
    : await db.prepare(`${base} AND lower(trim(name)) = ? LIMIT 20`).all(held.id, String(held.name || '').trim().toLowerCase());
  for (const r of nameRows) {
    const how = compareNames(held.name, r.name);
    if (how) add(r, how);
  }

  // Phone, by its last ten digits: "+63 917 590 7923" and "0917-590-7923" are
  // the same number.
  const phone = digitsOf(held.contact_number).slice(-10);
  if (phone.length === 10) {
    const rows = await db
      .prepare(`${base} AND contact_number LIKE ? LIMIT 500`)
      .all(held.id, `%${phone.slice(-4)}`);
    const same = rows.filter((r) => digitsOf(r.contact_number).slice(-10) === phone);
    // A number several Zoho customers share is a placeholder (09123456789) or
    // a switchboard, and says nothing about which business this is.
    if (same.length <= MAX_SHARED_PHONE) for (const r of same) add(r, 'phone');
  }

  // TIN, by its first nine digits — the branch code after them varies.
  const tin = digitsOf(held.tin);
  if (tin.length >= 9) {
    const rows = await db.prepare(`${base} AND tin LIKE ? LIMIT 500`).all(held.id, `${tin.slice(0, 3)}%`);
    for (const r of rows) if (digitsOf(r.tin).slice(0, 9) === tin.slice(0, 9)) add(r, 'tin');
  }

  const lto = String(held.lto_license_number || '').trim().toLowerCase();
  if (lto) {
    const rows = await db.prepare(`${base} AND lower(trim(lto_license_number)) = ? LIMIT 20`).all(held.id, lto);
    for (const r of rows) add(r, 'lto');
  }

  const email = String(held.email || '').trim().toLowerCase();
  if (email) {
    const rows = await db.prepare(`${base} AND lower(trim(email)) = ? LIMIT 20`).all(held.id, email);
    for (const r of rows) add(r, 'email');
  }

  const score = (e) => [...e.matched].reduce((s, m) => s + (MATCH_WEIGHT[m] || 0), 0);
  const top = [...found.values()].sort((a, b) => score(b) - score(a)).slice(0, 5);
  if (!top.length) return [];

  const ids = top.map((e) => e.row.id);
  const counts = await db
    .prepare(`SELECT customer_id, COUNT(*) AS c FROM orders WHERE customer_id IN (${ids.map(() => '?').join(',')}) GROUP BY customer_id`)
    .all(...ids);
  const orderCount = new Map(counts.map((r) => [r.customer_id, Number(r.c)]));

  return top.map(({ row, matched }) => ({
    id: row.id,
    name: row.name,
    contact_person: row.contact_person,
    contact_number: row.contact_number,
    email: row.email,
    tin: row.tin,
    lto_license_number: row.lto_license_number,
    category: row.category,
    type: row.type,
    address: row.address,
    is_active: row.is_active,
    zoho_contact_id: row.zoho_contact_id,
    order_count: orderCount.get(row.id) || 0,
    matched: [...matched].sort((a, b) => (MATCH_WEIGHT[b] || 0) - (MATCH_WEIGHT[a] || 0))
  }));
}

/** A customer still waiting for Zoho, or null. */
function getHeldCustomer(id) {
  return db
    .prepare(
      `SELECT * FROM customers
        WHERE id = ? AND zoho_contact_id IS NULL AND zoho_sync_status IN ('pending','failed')`
    )
    .get(id);
}

/**
 * Hand orders that never reached Zoho to the retry service, now that their
 * customer has a zoho_contact_id.
 *
 * Deliberately only orders that never reached Zoho and are still 'pending': an
 * order already 'synced' or 'failed' for its own reasons is not this
 * function's business, and re-queueing one would create a second Sales Order.
 */
async function releaseWaitingOrders(customerId, onlyOrderIds = null) {
  const zohoRetry = require('./zohoRetryService');
  let waiting = await db
    .prepare(
      `SELECT id, getmeds_order_id FROM orders
        WHERE customer_id = ? AND zoho_sync_status = 'pending' AND zoho_so_id IS NULL`
    )
    .all(customerId);
  if (onlyOrderIds) waiting = waiting.filter((o) => onlyOrderIds.includes(o.id));

  let released = 0;
  for (const order of waiting) {
    try {
      const payload = await buildZohoSalesOrderPayload(order.id);
      await zohoRetry.enqueue({
        orderId: order.id,
        payload,
        error: 'Customer was registered in Zoho — order queued for its Sales Order.'
      });
      released++;
    } catch (err) {
      // One order that cannot be queued must not stop the rest, and must not
      // undo the customer work that already succeeded.
      console.error(`[CUSTOMER_SYNC] could not queue ${order.getmeds_order_id}:`, err.message);
    }
  }
  return released;
}

/**
 * "This is the customer Zoho already has": move the waiting customer's orders
 * onto the Zoho one and delete the waiting copy. Nothing is created in Zoho.
 *
 * The Zoho customer's EMPTY fields are filled from the waiting one (phone,
 * TIN, licence, ...), locally only — the waiting copy often carries what the
 * rep typed, which a customer created by hand in Zoho may lack. Fields it
 * already has are never overwritten.
 */
async function linkHeldToExisting(heldId, targetId, actor, { details = null, zohoChanged = [] } = {}) {
  const { logEvent } = require('./auditService');
  const held = await getHeldCustomer(heldId);
  if (!held) return { ok: false, status: 404, reason: 'That customer is not waiting for Zoho.' };
  const target = await db.prepare('SELECT * FROM customers WHERE id = ? AND zoho_contact_id IS NOT NULL').get(targetId);
  if (!target) return { ok: false, status: 404, reason: 'The customer to use instead is not in Zoho.' };

  const orders = await db.prepare('SELECT id, getmeds_order_id, status FROM orders WHERE customer_id = ?').all(held.id);
  const now = new Date().toISOString();

  await db.transaction(async () => {
    await db.prepare('UPDATE orders SET customer_id = ?, updated_at = ? WHERE customer_id = ?').run(target.id, now, held.id);
    // Deleted before the fill below, so the two rows never hold the same
    // licence at once.
    await db.prepare('DELETE FROM customers WHERE id = ?').run(held.id);
    if (details) {
      // "Update customer": a person reviewed every field in the form, so what
      // it says wins — except a field left empty, which keeps what is there.
      const v = (x) => (x === undefined || x === null ? '' : String(x).trim());
      const addressLine = [v(details.address), v(details.city)].filter(Boolean).join(', ');
      await db
        .prepare(
          `UPDATE customers
              SET name               = COALESCE(NULLIF(?, ''), name),
                  contact_number     = COALESCE(NULLIF(?, ''), contact_number),
                  email              = COALESCE(NULLIF(?, ''), email),
                  tin                = COALESCE(NULLIF(?, ''), tin),
                  lto_license_number = COALESCE(NULLIF(?, ''), lto_license_number),
                  contact_person     = COALESCE(NULLIF(?, ''), contact_person),
                  category           = COALESCE(NULLIF(?, ''), category),
                  address            = COALESCE(NULLIF(?, ''), address)
            WHERE id = ?`
        )
        .run(
          v(details.name),
          v(details.contact_number),
          v(details.email),
          v(details.tin),
          v(details.lto_license_number),
          v(details.contact_person),
          v(details.category),
          addressLine,
          target.id
        );
    } else {
      await db
        .prepare(
          `UPDATE customers
              SET contact_number     = COALESCE(NULLIF(contact_number, ''), ?),
                  email              = COALESCE(NULLIF(email, ''), ?),
                  tin                = COALESCE(NULLIF(tin, ''), ?),
                  lto_license_number = COALESCE(NULLIF(lto_license_number, ''), ?),
                  contact_person     = COALESCE(NULLIF(contact_person, ''), ?),
                  category           = COALESCE(category, ?)
            WHERE id = ?`
        )
        .run(
          held.contact_number || null,
          held.email || null,
          held.tin || null,
          held.lto_license_number || null,
          held.contact_person || null,
          held.category || null,
          target.id
        );
    }
    for (const o of orders) {
      await logEvent({
        orderId: o.id,
        eventType: 'CUSTOMER_LINKED_TO_ZOHO',
        oldStatus: o.status,
        newStatus: o.status,
        actorId: actor?.id || null,
        actorName: actor?.name || actor?.email || 'System',
        notes:
          `Customer changed from "${held.name}" (waiting for Zoho, never created there) to "${target.name}", ` +
          'which Zoho already has — so the same business is not created in Zoho twice.' +
          (zohoChanged.length ? ` Its details were updated in Zoho: ${zohoChanged.join(', ')}.` : ''),
        metadata: { from_customer_id: held.id, to_customer_id: target.id, zoho_contact_id: target.zoho_contact_id }
      });
    }
  })();

  const released = await releaseWaitingOrders(target.id, orders.map((o) => o.id));
  return { ok: true, moved: orders.length, released, target: { id: target.id, name: target.name } };
}

/**
 * "Stop pushing this one": delete a waiting customer. Local only — it was
 * never in Zoho, so there is nothing there to delete.
 *
 * Refused while orders point at it: deleting would leave them without a
 * customer. Those are moved with linkHeldToExisting instead.
 */
async function discardHeldCustomer(heldId, actor) {
  const held = await getHeldCustomer(heldId);
  if (!held) return { ok: false, status: 404, reason: 'That customer is not waiting for Zoho.' };
  const { c } = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE customer_id = ?').get(held.id);
  if (Number(c) > 0) {
    return {
      ok: false,
      status: 409,
      code: 'HAS_ORDERS',
      reason:
        `${held.name} has ${c} order(s), which would be left without a customer. ` +
        'Use the matching Zoho customer instead — the orders move with it.'
    };
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(held.id);
  console.info(`[CUSTOMER_DISCARD] ${actor?.name || actor?.email || 'unknown'} deleted waiting customer ${held.id} "${held.name}"`);
  return { ok: true, name: held.name };
}

/** What the caller must provide, checked before anything is written anywhere. */
function validate(input) {
  const c = input || {};
  const problems = [];

  if (!String(c.display_name || '').trim()) problems.push('Display Name is required.');
  // Mandatory in this org's Zoho configuration (cf_contact_number). Caught
  // here so the message names the field rather than quoting Zoho at a rep.
  if (!String(c.contact_number || '').trim()) problems.push('Contact Number is required.');
  if (!String(c.phone || '').trim()) problems.push('Phone is required.');

  const billing = c.billing_address || {};
  if (!String(billing.address || '').trim()) problems.push('Billing Address is required.');
  if (!String(billing.phone || '').trim()) problems.push('Billing Address phone is required.');

  // Shipping falls back to billing, so it is only checked when the caller
  // said it differs.
  if (c.shipping_same_as_billing === false) {
    const shipping = c.shipping_address || {};
    if (!String(shipping.address || '').trim()) problems.push('Shipping Address is required.');
    if (!String(shipping.phone || '').trim()) problems.push('Shipping Address phone is required.');
  }

  // Deliberately optional. "Not sure" is a real answer, and forcing a choice on
  // somebody who does not have one produces a confident wrong value — which
  // for 'hospital' is wrong in both directions: claimed and the rep is blocked
  // on four attachments they do not need, missed and the controls vanish.
  if (c.category != null && c.category !== '' && !CATEGORIES.includes(c.category)) {
    problems.push(`Customer Type must be one of: ${CATEGORIES.join(', ')}.`);
  }

  for (const [label, value] of [
    ['License Issuance Date', c.license_issuance_date],
    ['License Expiry Date', c.license_expiry_date]
  ]) {
    // Zoho wants yyyy-mm-dd. A date it cannot parse is accepted and stored
    // empty, which looks like the field was left blank.
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) {
      problems.push(`${label} must be a date.`);
    }
  }

  return problems;
}

/**
 * Create the customer in Zoho, then here.
 *
 * Returns `{ created: false, duplicates }` when an existing customer matches,
 * so the caller can offer it rather than reporting a failure — nothing went
 * wrong, the customer simply already exists.
 */
async function createCustomer(input, actor) {
  const problems = validate(input);
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.code = 'VALIDATION_ERROR';
    err.problems = problems;
    throw err;
  }

  const duplicates = await findDuplicates(input);
  if (duplicates.length) return { created: false, duplicates };

  const shippingSame = input.shipping_same_as_billing !== false;
  const payload = {
    ...input,
    customer_sub_type: input.customer_sub_type === 'individual' ? 'individual' : 'business',
    shipping_address: shippingSame ? input.billing_address : input.shipping_address
  };

  let contact;
  try {
    const res = await zoho.createContact(payload);
    contact = res?.contact;
  } catch (err) {
    // ── "not authorized" means a MISSING OAUTH SCOPE, not a bad request ─────
    //
    // Sep 11, 2026. Zoho answers "You are not authorized to perform this
    // operation" for this, and that sentence sends whoever reads it looking at
    // the form, the payload and the custom field ids — none of which are the
    // problem. This org's refresh token was issued with:
    //
    //   ZohoInventory.salesorders.CREATE / .READ
    //   ZohoInventory.contacts.READ
    //   ZohoInventory.items.READ
    //
    // Contacts are READ-only. No amount of correct payload fixes that; the
    // refresh token has to be reissued with ZohoInventory.contacts.CREATE
    // added. So the message says so, rather than making somebody rediscover
    // it.
    // ── WHEN TO HOLD ──────────────────────────────────────────────────────
    //
    // Sep 11, 2026, widened. It started as "the contacts.CREATE scope is
    // missing", which was the known cause at the time. Then the refresh token
    // got rate-limited by Zoho and every create came back as a hard 502 — the
    // rep lost the whole form to a condition that clears itself in an hour.
    //
    // The question that actually matters is not WHY Zoho said no, it is
    // whether saying no tells us anything about THIS customer. A missing
    // scope, an expired token, a throttle, a network failure: none of them are
    // about the customer, all of them pass, and in every one of them the
    // useful thing to do is keep the work and push it later.
    //
    // A refusal ABOUT the customer — a duplicate LTO licence, a malformed
    // field — is the opposite: it will not fix itself, and holding it would
    // queue something guaranteed to fail forever.
    const zohoUnreachable = isZohoUnreachable(err.message);

    if (zohoUnreachable) {
      // ── HOLD, rather than refuse ────────────────────────────────────────
      //
      // Sep 11, 2026. Zoho's token for this org grants contacts.READ and not
      // .CREATE, and reissuing it needs the API Console, which is not always
      // reachable. Turning the rep away mid-order is the dead end this whole
      // feature was built to remove, so the customer is kept HERE, marked
      // pending, with the payload that will create it later.
      //
      // What it deliberately does NOT do is fake a zoho_contact_id. A pending
      // customer has none, which is what keeps it distinguishable from a real
      // one everywhere downstream — an order against it is held rather than
      // sent, because createSalesOrder refuses an unmapped customer loudly.
      return holdCustomer(input, payload, err.message);
    }

    // Zoho refused for some other reason. The likeliest is the unique licence
    // number on a contact this database has not synced yet — findDuplicates
    // only sees what is local, so Zoho is the backstop rather than the first
    // line.
    const e = new Error(
      /already exists/i.test(err.message)
        ? `Zoho already has a customer with these details: ${err.message}`
        : `Zoho refused to create this customer: ${err.message}`
    );
    e.code = 'ZOHO_REFUSED';
    throw e;
  }

  if (!contact?.contact_id) {
    const e = new Error('Zoho accepted the customer but returned no contact id.');
    e.code = 'ZOHO_REFUSED';
    throw e;
  }

  const now = new Date().toISOString();
  const billing = payload.billing_address || {};
  const addressLine = [billing.address, billing.street2, billing.city, billing.state, billing.zip]
    .filter(Boolean)
    .join(', ');

  // `type` (credit/direct), not customer_type — and 'direct' because a
  // customer created mid-order has no agreed credit limit yet. Management can
  // change it; defaulting to 'credit' would grant terms nobody approved.
  //
  // `source` is 'zoho' because that is where the record was born, even though
  // this app asked for it — the id below came from Zoho, and the customer sync
  // must treat this row as one it owns rather than a local duplicate.
  await db
    .prepare(
      `INSERT INTO customers (name, type, category, contact_person, contact_number, email, address,
                              source, zoho_contact_id, tin, lto_license_number,
                              is_active, created_at, last_synced_at)
       VALUES (?, 'direct', ?, ?, ?, ?, ?, 'zoho', ?, ?, ?, 1, ?, ?)`
    )
    .run(
      String(input.display_name).trim(),
      // NULL when the rep said "not sure" — see validate().
      input.category || null,
      [input.first_name, input.last_name].filter(Boolean).join(' ') || null,
      String(input.contact_number).trim(),
      input.email || null,
      addressLine || 'See Zoho',
      contact.contact_id,
      input.tin || null,
      input.lto_license_number || null,
      now,
      now
    );

  const saved = await db
    .prepare('SELECT * FROM customers WHERE zoho_contact_id = ?')
    .get(contact.contact_id);

  return {
    created: true,
    customer: saved,
    zoho_contact_id: contact.contact_id,
    shipping_same_as_billing: shippingSame,
    created_by: actor?.id || null
  };
}

/**
 * Store a customer that Zoho could not accept yet.
 *
 * The whole creation payload is kept alongside the row, because `customers`
 * does not hold everything Zoho needs — licence dates, LTO type, both
 * addresses, the custom fields. Without it, syncing later would mean asking
 * the rep to retype what they already entered, which is how a queue quietly
 * stops being worked.
 */
async function holdCustomer(input, payload, reason) {
  const now = new Date().toISOString();
  const billing = payload.billing_address || {};
  const addressLine = [billing.address, billing.street2, billing.city, billing.state, billing.zip]
    .filter(Boolean)
    .join(', ');

  await db
    .prepare(
      `INSERT INTO customers (name, type, category, contact_person, contact_number, email, address,
                              source, zoho_contact_id, tin, lto_license_number,
                              is_active, created_at, last_synced_at,
                              zoho_sync_status, zoho_pending_payload, zoho_sync_error)
       VALUES (?, 'direct', ?, ?, ?, ?, ?, 'local', NULL, ?, ?, 1, ?, NULL,
               'pending', ?, ?)`
    )
    .run(
      String(input.display_name).trim(),
      input.category || null,
      [input.first_name, input.last_name].filter(Boolean).join(' ') || null,
      String(input.contact_number).trim(),
      input.email || null,
      addressLine || 'See Zoho',
      input.tin || null,
      input.lto_license_number || null,
      now,
      JSON.stringify(payload),
      reason
    );

  const saved = await db
    .prepare('SELECT * FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(String(input.display_name).trim());

  return { created: true, held: true, customer: saved, reason };
}

/**
 * Push one held customer to Zoho.
 *
 * Called from the admin screen once the token has been reissued, never on a
 * timer: the reason these are held is a missing OAuth scope, and a background
 * retry would produce thousands of guaranteed failures and a log nobody reads.
 */
async function syncHeldCustomer(customerId, { allowMatches = false } = {}) {
  const row = await db
    .prepare("SELECT * FROM customers WHERE id = ? AND zoho_sync_status = 'pending'").get(customerId);
  if (!row) return { ok: false, reason: 'Not a pending customer.' };

  // Sep 14, 2026: never create what Zoho may already have. A likely match is
  // held back for a person — see findZohoMatches. `allowMatches` is that
  // person having looked and said "not the same, push it".
  if (!allowMatches) {
    const matches = await findZohoMatches(row);
    if (matches.length) {
      return { ok: false, needsReview: true, matches, reason: 'Looks like a customer Zoho already has.' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(row.zoho_pending_payload || '{}');
  } catch {
    return { ok: false, reason: 'The stored payload is unreadable.' };
  }

  try {
    const res = await zoho.createContact(payload);
    const contactId = res?.contact?.contact_id;
    if (!contactId) return { ok: false, reason: 'Zoho returned no contact id.' };

    await db
      .prepare(
        `UPDATE customers
            SET zoho_contact_id = ?, zoho_sync_status = 'synced', source = 'zoho',
                zoho_pending_payload = NULL, zoho_sync_error = NULL, last_synced_at = ?
          WHERE id = ?`
      )
      .run(contactId, new Date().toISOString(), customerId);

    // ── release the orders that were waiting on this customer ───────────
    //
    // Without this, a synced customer leaves its orders sitting at
    // zoho_sync_status 'pending' forever, and somebody has to notice each one
    // and push it by hand. See releaseWaitingOrders.
    const released = await releaseWaitingOrders(customerId);

    return { ok: true, zoho_contact_id: contactId, released };
  } catch (err) {
    // The scope is still missing: stays pending, so the next attempt after the
    // token is fixed picks it up. Anything else is a real refusal about THIS
    // customer (a duplicate licence, say) and will not fix itself — marked
    // failed so it stops being retried and starts being looked at.
    const stillBlocked = isZohoUnreachable(err.message);
    await db
      .prepare(`UPDATE customers SET zoho_sync_status = ?, zoho_sync_error = ? WHERE id = ?`)
      .run(stillBlocked ? 'pending' : 'failed', err.message, customerId);
    return { ok: false, reason: err.message, stillBlocked };
  }
}

/** Every customer waiting to reach Zoho, oldest first. */
async function listHeldCustomers() {
  return db
    .prepare(
      `SELECT id, name, contact_person, contact_number, email, tin, lto_license_number, category, type,
              address, created_at, zoho_sync_status, zoho_sync_error,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = customers.id) AS order_count
         FROM customers
        WHERE zoho_sync_status IN ('pending','failed')
        ORDER BY zoho_sync_status DESC, created_at ASC`
    )
    .all();
}

module.exports = {
  createCustomer,
  findDuplicates,
  validate,
  normalise,
  CATEGORIES,
  holdCustomer,
  syncHeldCustomer,
  listHeldCustomers,
  isZohoUnreachable,
  findZohoMatches,
  compareNames,
  getHeldCustomer,
  linkHeldToExisting,
  discardHeldCustomer
};
