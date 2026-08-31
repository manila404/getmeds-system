// Aug 30, 2026: "edit trail" feature — when someone edits a Sales Order
// directly in Zoho (Payment Terms, Invoicing From, Doctor Name, Source,
// Delivery Method, Terms & Conditions), this app should show that edit in
// the order's own audit trail, not just whatever Zoho itself displays.
//
// Field names/shapes here were confirmed live against a real Sales Order in
// this org (ZohoInventory_get_sales_order on SO-66824), not assumed:
//   - payment_terms_label, delivery_method, terms  -> native top-level
//     fields on the Sales Order object (payment_terms_label is a *string*
//     like "net " / "30 days" — payment_terms itself is Zoho's internal
//     day-count integer, not what a human edited, so it's ignored here).
//   - cf_invoicing_from, cf_doctor_name, cf_source  -> custom fields, read
//     from custom_field_hash (Zoho omits a custom field from the hash
//     entirely when it's blank, rather than sending an empty string — this
//     is handled below).
//
// Deliberately NOT diffed here: Salesperson (no local column this app
// stores it against — see ZOHO_SALES_ORDER_FIELD_MAPPING.md), line items,
// addresses, tax/discount. Keeping this to the fields the "Create New
// Order" form itself collects keeps the trail focused on edits a MedRep or
// Finance user would actually recognize and care about.

const TRACKED_FIELDS = [
  {
    key: 'invoicing_from',
    label: 'Invoicing From',
    localColumn: 'invoicing_from',
    zohoValue: (so) => so.custom_field_hash?.cf_invoicing_from ?? null
  },
  {
    key: 'doctor_name',
    label: 'Doctor Name',
    localColumn: 'intake_doctor',
    zohoValue: (so) => so.custom_field_hash?.cf_doctor_name ?? null
  },
  {
    key: 'source',
    label: 'Source',
    localColumn: 'intake_source',
    zohoValue: (so) => so.custom_field_hash?.cf_source ?? null
  },
  {
    key: 'delivery_method',
    label: 'Delivery Method',
    localColumn: 'intake_delivery_method',
    zohoValue: (so) => so.delivery_method ?? null
  },
  {
    key: 'terms',
    label: 'Terms and Condition',
    localColumn: 'intake_terms',
    zohoValue: (so) => so.terms ?? null
  },
  {
    key: 'payment_terms',
    label: 'Payment Terms',
    localColumn: 'intake_payment_terms',
    zohoValue: (so) => so.payment_terms_label ?? null
  }
];

// Blank/whitespace-only and null/undefined are all treated as "not set" so
// e.g. `''` (local, never filled in) and an absent custom field (Zoho's
// shape when blank) compare as equal rather than showing a false edit.
function normalize(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Compares a live Zoho Sales Order object against the local `orders` row it
 * was created from, for the fields listed in TRACKED_FIELDS. Returns an
 * array of { key, label, localColumn, oldValue, newValue } — one entry per
 * field that actually changed. Empty array means nothing this app tracks
 * was edited (the edit may still be real — e.g. a rate or address change —
 * just not one of these fields).
 */
function diffSalesOrderFields(zohoSalesOrder, localOrder) {
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    const oldValue = normalize(localOrder[field.localColumn]);
    const newValue = normalize(field.zohoValue(zohoSalesOrder));
    if (oldValue !== newValue) {
      changes.push({ key: field.key, label: field.label, localColumn: field.localColumn, oldValue, newValue });
    }
  }
  return changes;
}

/**
 * Human-readable one-line-per-field summary, e.g.:
 *   "Payment Terms: net → 30 days; Invoicing From: (blank) → 2mg Incorporated"
 */
function summarizeChanges(changes) {
  return changes
    .map((c) => `${c.label}: ${c.oldValue ?? '(blank)'} → ${c.newValue ?? '(blank)'}`)
    .join('; ');
}

module.exports = { TRACKED_FIELDS, diffSalesOrderFields, summarizeChanges };
