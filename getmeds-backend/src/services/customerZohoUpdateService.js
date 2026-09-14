const db = require('../db/database');
const zoho = require('../integrations/zoho');
const {
  CATEGORIES,
  compareNames,
  getHeldCustomer,
  isZohoUnreachable,
  linkHeldToExisting
} = require('./customerCreateService');

/**
 * "Update customer": a waiting customer turns out to be one Zoho already has,
 * so correct the Zoho customer from what the rep typed, then use it.
 *
 * Sep 14, 2026. 1ST SPECIALITY PHARMA waited here while "1ST SPECIALTY PHARMA"
 * was created directly in Zoho. The duplicate review offered "use the one in
 * Zoho" and "push as new"; the business asked for a third answer — update the
 * Zoho customer's details, then use it.
 *
 * ── READ ZOHO LIVE, NOT THE LOCAL COPY ───────────────────────────────────────
 *
 * The local customers table keeps only a name and a few columns of each Zoho
 * contact. For 1ST SPECIALTY PHARMA it had no TIN, licence, phone or address —
 * while Zoho itself had the same TIN and the same LTO licence as the waiting
 * customer. A comparison or a form built from the local copy would have shown
 * blanks and invited overwriting values Zoho already holds. So both read the
 * contact from Zoho.
 *
 * ── SEND ONLY WHAT CHANGED ───────────────────────────────────────────────────
 *
 * The form starts with Zoho's value where Zoho has one and the waiting value
 * where it does not; the person edits anything. What is sent is the fields
 * that differ from Zoho's current value — and never an empty one, so leaving a
 * field blank keeps what Zoho has rather than clearing it. Contact persons are
 * never sent (see LiveZohoAdapter.updateContact).
 *
 * Zoho first, local second: if Zoho refuses, nothing here changes.
 */

const FIELD_LABELS = {
  name: 'name',
  contact_number: 'contact number',
  phone: 'phone',
  email: 'email',
  tin: 'TIN',
  lto_license_number: 'LTO licence',
  lto_type: 'LTO type',
  license_owner: 'licence owner',
  license_issuance_date: 'licence issuance date',
  license_expiry_date: 'licence expiry date',
  address: 'address',
  city: 'city'
};
const CUSTOM_KEYS = [
  'contact_number',
  'tin',
  'lto_license_number',
  'lto_type',
  'license_owner',
  'license_issuance_date',
  'license_expiry_date'
];

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const digitsOf = (v) => String(v || '').replace(/\D/g, '');

/** A Zoho contact as the form's fields. Live contacts carry custom_fields; the mock, flat cf_* keys. */
function fromZohoContact(c) {
  const byApi = {};
  for (const f of c.custom_fields || []) if (f.api_name) byApi[f.api_name] = f.value;
  // `_unformatted` before the flat key: Zoho's flat cf_ dates read "14 Mar 2026".
  const cf = (key) => clean(byApi[`cf_${key}`] ?? c[`cf_${key}_unformatted`] ?? c[`cf_${key}`]);
  const billing = c.billing_address || {};
  const persons = c.contact_persons || [];
  const primary = persons.find((p) => p.is_primary_contact) || persons[0];
  return {
    name: clean(c.contact_name),
    contact_person: primary ? [primary.first_name, primary.last_name].map(clean).filter(Boolean).join(' ') : '',
    contact_number: cf('contact_number'),
    phone: clean(c.phone || c.mobile),
    email: clean(c.email),
    tin: cf('tin'),
    lto_license_number: cf('lto_license_number'),
    lto_type: cf('lto_type'),
    license_owner: cf('license_owner'),
    license_issuance_date: cf('license_issuance_date'),
    license_expiry_date: cf('license_expiry_date'),
    address: clean(billing.address),
    city: clean(billing.city)
  };
}

/** The local copy, when Zoho cannot be read — what little it has. */
function fromLocalRow(row) {
  return {
    name: clean(row.name),
    contact_person: clean(row.contact_person),
    contact_number: clean(row.contact_number),
    phone: '',
    email: clean(row.email),
    tin: clean(row.tin),
    lto_license_number: clean(row.lto_license_number),
    lto_type: '',
    license_owner: '',
    license_issuance_date: '',
    license_expiry_date: '',
    address: clean(row.address === 'See Zoho' ? '' : row.address),
    city: ''
  };
}

/** The waiting customer: its row plus the creation payload, which holds what the row does not. */
function fromWaiting(held) {
  let p = {};
  try {
    p = JSON.parse(held.zoho_pending_payload || '{}') || {};
  } catch {
    p = {};
  }
  const billing = p.billing_address || {};
  return {
    name: clean(held.name),
    contact_person: clean(held.contact_person) || [p.first_name, p.last_name].map(clean).filter(Boolean).join(' '),
    contact_number: clean(p.contact_number || held.contact_number),
    phone: clean(p.phone),
    email: clean(p.email || held.email),
    tin: clean(p.tin || held.tin),
    lto_license_number: clean(p.lto_license_number || held.lto_license_number),
    lto_type: clean(p.lto_type),
    license_owner: clean(p.license_owner),
    license_issuance_date: clean(p.license_issuance_date),
    license_expiry_date: clean(p.license_expiry_date),
    address: clean(billing.address || (held.address === 'See Zoho' ? '' : held.address)),
    city: clean(billing.city),
    category: clean(held.category)
  };
}

/** What makes these two look like one business — the same judgement as findZohoMatches, on live values. */
function matchedFields(w, z) {
  const matched = [];
  const name = compareNames(w.name, z.name);
  if (name) matched.push(name);
  const lto = w.lto_license_number.toLowerCase();
  if (lto && lto === z.lto_license_number.toLowerCase()) matched.push('lto');
  const tin = digitsOf(w.tin);
  if (tin.length >= 9 && tin.slice(0, 9) === digitsOf(z.tin).slice(0, 9)) matched.push('tin');
  if (w.email && w.email.toLowerCase() === z.email.toLowerCase()) matched.push('email');
  const phones = (d) => [d.contact_number, d.phone].map((x) => digitsOf(x).slice(-10)).filter((x) => x.length === 10);
  if (phones(w).some((x) => phones(z).includes(x))) matched.push('phone');
  return matched;
}

async function loadPair(heldId, targetId) {
  const held = await getHeldCustomer(heldId);
  if (!held) return { error: { ok: false, status: 404, reason: 'That customer is not waiting for Zoho.' } };
  const target = await db.prepare('SELECT * FROM customers WHERE id = ? AND zoho_contact_id IS NOT NULL').get(targetId);
  if (!target) return { error: { ok: false, status: 404, reason: 'The customer to compare with is not in Zoho.' } };
  return { held, target };
}

async function readZohoContact(contactId) {
  const res = await zoho.getContact(contactId);
  if (!res?.contact) throw new Error(res?.message || 'Zoho returned no contact.');
  return res.contact;
}

/** GET /api/customers/:id/zoho-compare — the waiting customer next to the live Zoho one. */
async function getComparison(heldId, targetId) {
  const { held, target, error } = await loadPair(heldId, targetId);
  if (error) return error;

  let zohoDetails;
  let source = 'zoho';
  let zohoError = null;
  try {
    zohoDetails = fromZohoContact(await readZohoContact(target.zoho_contact_id));
  } catch (err) {
    // Still worth showing: the local copy, labelled as such.
    zohoDetails = fromLocalRow(target);
    source = 'local';
    zohoError = err.message;
  }

  const waiting = fromWaiting(held);
  const counts = await db
    .prepare('SELECT customer_id, COUNT(*) AS c FROM orders WHERE customer_id IN (?, ?) GROUP BY customer_id')
    .all(held.id, target.id);
  const count = (id) => Number(counts.find((r) => r.customer_id === id)?.c || 0);

  return {
    ok: true,
    waiting: { ...waiting, order_count: count(held.id) },
    zoho: { ...zohoDetails, category: clean(target.category), order_count: count(target.id) },
    source,
    zoho_error: zohoError,
    matched: matchedFields(waiting, zohoDetails),
    target: { id: target.id, name: target.name, zoho_contact_id: target.zoho_contact_id }
  };
}

/** The form checked before anything is sent anywhere. */
function validateForm(form) {
  const problems = [];
  if (!clean(form.name)) problems.push('Name is required.');
  // Mandatory in this org's Zoho configuration (cf_contact_number).
  if (!clean(form.contact_number)) problems.push('Contact Number is required.');
  for (const [key, label] of [['license_issuance_date', 'License Issuance Date'], ['license_expiry_date', 'License Expiry Date']]) {
    if (clean(form[key]) && !/^\d{4}-\d{2}-\d{2}$/.test(clean(form[key]))) problems.push(`${label} must be a date (yyyy-mm-dd).`);
  }
  if (clean(form.category) && !CATEGORIES.includes(clean(form.category))) {
    problems.push(`Customer Type must be one of: ${CATEGORIES.join(', ')}.`);
  }
  return problems;
}

/**
 * The update to send: only fields that differ from what Zoho has now, and
 * never an empty one. `raw` is the live contact, for the address objects.
 */
function buildContactUpdate(raw, form) {
  const current = fromZohoContact(raw);
  const changes = {};
  const changed = [];
  const differs = (key) => clean(form[key]) !== '' && clean(form[key]) !== current[key];

  if (differs('name')) {
    changes.contact_name = clean(form.name);
    // The company name follows only when it was the same as the old name —
    // one that says something else was set on purpose.
    const company = clean(raw.company_name);
    if (!company || company === current.name) changes.company_name = clean(form.name);
    changed.push(FIELD_LABELS.name);
  }
  for (const key of ['email', 'phone']) {
    if (differs(key)) {
      changes[key] = clean(form[key]);
      changed.push(FIELD_LABELS[key]);
    }
  }
  if (differs('address') || differs('city')) {
    // The whole address object, carrying over what the form does not show
    // (country, zip, ...), so an update is never read as clearing those.
    const keep = (a) => {
      const out = {};
      for (const k of ['attention', 'address', 'street2', 'city', 'state', 'zip', 'country', 'phone']) {
        if (clean(a?.[k])) out[k] = clean(a[k]);
      }
      return out;
    };
    const billing = { ...keep(raw.billing_address), address: clean(form.address) || current.address, city: clean(form.city) || current.city };
    changes.billing_address = billing;
    // Shipping follows billing only when it was the same address, or empty.
    const ship = keep(raw.shipping_address);
    if (!ship.address || ship.address === current.address) changes.shipping_address = { ...ship, address: billing.address, city: billing.city };
    if (differs('address')) changed.push(FIELD_LABELS.address);
    if (differs('city')) changed.push(FIELD_LABELS.city);
  }
  const custom = {};
  for (const key of CUSTOM_KEYS) {
    if (differs(key)) {
      custom[key] = clean(form[key]);
      changed.push(FIELD_LABELS[key]);
    }
  }
  if (Object.keys(custom).length) changes.custom = custom;
  return { changes, changed };
}

/**
 * POST /api/customers/:id/link { target_id, update } — update the Zoho
 * customer from the form, then use it (orders move, waiting copy deleted).
 */
async function updateAndLink(heldId, targetId, form, actor) {
  const problems = validateForm(form || {});
  if (problems.length) return { ok: false, status: 400, code: 'VALIDATION_ERROR', reason: problems.join(' ') };

  const { target, error } = await loadPair(heldId, targetId);
  if (error) return error;

  // The current state is read first: an update built without it could not
  // tell what changed, and would send every field.
  let raw;
  try {
    raw = await readZohoContact(target.zoho_contact_id);
  } catch (err) {
    return {
      ok: false,
      status: 503,
      code: 'ZOHO_UNREACHABLE',
      reason: `Could not read ${target.name} from Zoho, so nothing was changed: ${err.message}`
    };
  }

  const { changes, changed } = buildContactUpdate(raw, form);
  if (changed.length) {
    try {
      await zoho.updateContact(target.zoho_contact_id, changes);
    } catch (err) {
      const unreachable = isZohoUnreachable(err.message);
      return {
        ok: false,
        status: unreachable ? 503 : 422,
        code: unreachable ? 'ZOHO_UNREACHABLE' : 'ZOHO_REFUSED',
        reason:
          (unreachable ? 'Zoho could not be updated right now' : 'Zoho refused the update') +
          `: ${err.message}. Nothing was changed — the waiting customer and its orders are as they were.`
      };
    }
  }

  const out = await linkHeldToExisting(heldId, targetId, actor, { details: form, zohoChanged: changed });
  return { ...out, zoho_updated: changed };
}

module.exports = { getComparison, updateAndLink, buildContactUpdate, fromZohoContact, validateForm };
