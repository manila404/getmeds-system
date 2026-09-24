'use strict';

/**
 * The Client Details modal's data: one customer, laid out like Zoho's own
 * "Edit Customer" screen.
 *
 * Sep 24, 2026.
 *
 * Where each field comes from was checked against a live contact, not guessed.
 * Zoho returns the standard fields flat on the contact and this org's custom
 * fields as `cf_<api_name>` — each in three spellings: `cf_x` (display),
 * `cf_x_formatted` and `cf_x_unformatted` (the raw value: an ISO date, a real
 * boolean). The raw one is what is read where it exists, because the display
 * one is a locale string ("14 Mar 2026") and the checkbox comes back as the text
 * "false", which is truthy.
 *
 *   Custom ID            cf_custom_id                (autonumber, read-only in Zoho)
 *   Customer Type        customer_sub_type           business | individual
 *   Company Name         company_name
 *   Primary Contact      contact_salutation + first_name + last_name
 *                        (the primary contact person when those are blank)
 *   Display Name         contact_name
 *   Email                email
 *   Phones               phone, mobile, and cf_contact_number (mandatory here)
 *   Address              billing_address / shipping_address
 *                        { address (street 1), street2, city, state, zip, country, phone }
 *   Is Doctor            cf_is_doctor
 *   Company ID           company_id
 *   LTO License Number   cf_lto_license_number
 *   LTO Type             cf_lto_type
 *   License Issuance     cf_license_issuance_date
 *   License Expiry       cf_license_expiry_date
 *   TIN                  cf_tin
 *
 * A customer that is not in Zoho (created here and still waiting, or local-only)
 * has no contact to read, so it falls back to what the local row holds. Those
 * fields are not invented: anything the local row does not have stays null and
 * the modal shows it as empty.
 */

const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** First present value, as a trimmed string. */
const firstOf = (...values) => {
  for (const v of values) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
};

/** Zoho's checkbox: a real boolean in `_unformatted`, the text "true"/"false" elsewhere. */
function toBool(contact, key) {
  const raw = contact[`${key}_unformatted`] !== undefined ? contact[`${key}_unformatted`] : contact[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

/** yyyy-mm-dd from Zoho's raw date; a display string is only a fallback. */
function toIsoDate(contact, key) {
  const raw = str(contact[`${key}_unformatted`]) || str(contact[key]);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(`${raw} UTC`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function mapAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    street1: str(a.address),
    street2: str(a.street2),
    city: str(a.city),
    state: firstOf(a.state, a.state_code),
    zip: str(a.zip),
    country: str(a.country),
    phone: str(a.phone),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function primaryContactOf(contact) {
  const persons = Array.isArray(contact.contact_persons) ? contact.contact_persons : [];
  const person = persons.find((p) => p && p.is_primary_contact) || persons[0] || {};
  const salutation = firstOf(contact.contact_salutation, person.salutation);
  const first = firstOf(contact.first_name, person.first_name);
  const last = firstOf(contact.last_name, person.last_name);
  const full = [salutation, first, last].filter(Boolean).join(' ') || null;
  return { salutation, first_name: first, last_name: last, full };
}

/** A Zoho contact -> the modal's fields. */
function mapZohoContact(contact) {
  const c = contact || {};
  const docs = Array.isArray(c.documents) ? c.documents : [];
  return {
    custom_id: str(c.cf_custom_id_unformatted) || str(c.cf_custom_id),
    customer_type: firstOf(c.customer_sub_type),
    company_name: str(c.company_name),
    primary_contact: primaryContactOf(c),
    display_name: str(c.contact_name),
    email: str(c.email),
    phones: {
      work: str(c.phone),
      mobile: str(c.mobile),
      contact_number: str(c.cf_contact_number_unformatted) || str(c.cf_contact_number),
    },
    billing_address: mapAddress(c.billing_address),
    shipping_address: mapAddress(c.shipping_address),
    is_doctor: toBool(c, 'cf_is_doctor'),
    additional: {
      company_id: str(c.company_id),
      lto_license_number: str(c.cf_lto_license_number_unformatted) || str(c.cf_lto_license_number),
      lto_type: str(c.cf_lto_type_unformatted) || str(c.cf_lto_type),
      license_issuance_date: toIsoDate(c, 'cf_license_issuance_date'),
      license_expiry_date: toIsoDate(c, 'cf_license_expiry_date'),
      tin: str(c.cf_tin_unformatted) || str(c.cf_tin),
    },
    // Files already attached to the contact in Zoho, names only. Read-only:
    // this app stores its own documents separately (customer_documents).
    zoho_documents: docs
      .map((d) => ({ file_name: firstOf(d && d.file_name, d && d.document_name, d && d.name) }))
      .filter((d) => d.file_name),
  };
}

/** A customer row with no Zoho contact behind it -> the same shape, from what is stored. */
function mapLocalCustomer(row) {
  const r = row || {};
  return {
    custom_id: null,
    customer_type: null,
    company_name: str(r.name),
    primary_contact: { salutation: null, first_name: null, last_name: null, full: str(r.contact_person) },
    display_name: str(r.name),
    email: str(r.email),
    phones: { work: null, mobile: null, contact_number: str(r.contact_number) },
    // One free-text line is all a local customer has; it goes in Street 1
    // rather than being split by guesswork.
    billing_address: str(r.address)
      ? { street1: str(r.address), street2: null, city: null, state: null, zip: null, country: null, phone: null }
      : null,
    shipping_address: null,
    is_doctor: null,
    additional: {
      company_id: null,
      lto_license_number: str(r.lto_license_number),
      lto_type: null,
      license_issuance_date: null,
      license_expiry_date: null,
      tin: str(r.tin),
    },
    zoho_documents: [],
  };
}

module.exports = { mapZohoContact, mapLocalCustomer };
