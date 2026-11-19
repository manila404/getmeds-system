const db = require('../db/database');
const zoho = require('../integrations/zoho');

/**
 * Set a customer's TIN locally and, best-effort, on their Zoho contact.
 *
 * Sep 9, 2026. The logic was written on Sep 8 inside customers.controller.js's
 * updateCustomerTin and was the only place it lived. The order form now needs
 * the same thing — the Master Form shows a customer's TIN and lets a MedRep
 * fill it in when Zoho has none — and a second copy of a Zoho write, however
 * narrow, is exactly the kind of duplication that drifts. So it lives here and
 * both callers share it.
 *
 * Why the order form needs to write at all, rather than just displaying: Zoho
 * REFUSES to create a Sales Order for a "business" sub-type contact with an
 * empty cf_tin (see ZohoAdapter.updateContactTin). A TIN typed on the order
 * form that never reached the contact would leave the MedRep watching their
 * order fail for a value they had just supplied.
 *
 * ── SOFT-GATED, ALWAYS ──────────────────────────────────────────────────────
 * A Zoho failure never blocks the local save and never throws to the caller.
 * The result says what happened so a caller can report it; nothing here is
 * allowed to turn "your TIN was saved" into an error.
 *
 * @param {number|string} customerId
 * @param {string|null} tin - blank/whitespace is treated as clearing it
 * @returns {Promise<{ok:boolean, changed:boolean, customer:object|null, zohoPushed:boolean, zohoError:string|null, code?:string}>}
 */
async function setCustomerTin(customerId, tin) {
  const value = tin === null || tin === undefined ? null : String(tin).trim() || null;

  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) {
    return { ok: false, code: 'NOT_FOUND', changed: false, customer: null, zohoPushed: false, zohoError: null };
  }

  // Nothing to do when it already says this. Worth checking rather than
  // writing unconditionally: the order form sends the TIN it was shown on
  // every submission, so without this every order raised for a customer that
  // already has one would make a pointless Zoho write.
  if ((customer.tin || null) === value) {
    return { ok: true, changed: false, customer, zohoPushed: false, zohoError: null };
  }

  await db.prepare('UPDATE customers SET tin = ? WHERE id = ?').run(value, customerId);

  let zohoPushed = false;
  let zohoError = null;
  if (value && customer.zoho_contact_id) {
    try {
      await zoho.updateContactTin(customer.zoho_contact_id, value);
      zohoPushed = true;
    } catch (err) {
      // The local save stands. The caller reports zoho_pushed: false and the
      // value can be re-sent later rather than being lost.
      zohoError = err.message;
      console.warn(`[TIN] updateContactTin failed for ${customer.zoho_contact_id}:`, err.message);
    }
  }

  const updated = await db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  return { ok: true, changed: true, customer: updated, zohoPushed, zohoError };
}

function readContactCustomField(contact, apiName) {
  if (!contact) return null;
  if (contact[apiName]) {
    const v = String(contact[apiName]).trim();
    if (v) return v;
  }
  if (contact.custom_field_hash && contact.custom_field_hash[apiName]) {
    const v = String(contact.custom_field_hash[apiName]).trim();
    if (v) return v;
  }
  if (Array.isArray(contact.custom_fields)) {
    const hit = contact.custom_fields.find((f) => f && f.api_name === apiName && f.value != null && String(f.value).trim() !== '');
    if (hit) return String(hit.value).trim();
  }
  return null;
}

function extractZohoContactCompliance(contact) {
  return {
    tin: readContactCustomField(contact, 'cf_tin'),
    lto_license_number: readContactCustomField(contact, 'cf_lto_license_number')
  };
}

/**
 * Best-effort read of a customer's cf_tin and cf_lto_license_number from Zoho
 * when either field is blank locally. Never throws to callers.
 */
async function refreshCustomerComplianceFromZoho(customerId, zohoContactId, adapter = zoho) {
  if (!customerId || !zohoContactId || typeof adapter?.getContact !== 'function') {
    return { tin: null, lto_license_number: null, synced: false };
  }
  try {
    const res = await adapter.getContact(zohoContactId);
    const contact = res && res.contact;
    if (!contact) return { tin: null, lto_license_number: null, synced: false };
    const { tin, lto_license_number } = extractZohoContactCompliance(contact);
    if (tin || lto_license_number) {
      await db.prepare(`
        UPDATE customers
           SET tin = COALESCE(?, tin),
               lto_license_number = COALESCE(?, lto_license_number),
               last_synced_at = datetime('now')
         WHERE id = ?
      `).run(tin, lto_license_number, customerId);
    }
    return { tin, lto_license_number, synced: true };
  } catch (err) {
    console.warn(`[COMPLIANCE] getContact failed for customer ${customerId} (${zohoContactId}):`, err.message);
    return { tin: null, lto_license_number: null, synced: false };
  }
}

module.exports = {
  setCustomerTin,
  extractZohoContactCompliance,
  refreshCustomerComplianceFromZoho
};
