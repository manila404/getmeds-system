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
// Deliberately NOT diffed here: line items, addresses, tax/discount. Keeping
// this to the fields the "Create New Order" form itself collects keeps the
// trail focused on edits a MedRep or Finance user would actually recognize
// and care about.
//
// Sep 11, 2026: Salesperson IS diffed now. It used to be excluded for having
// no local column; orders.salesperson has existed since Sep 5 and every order
// raised here stores the one it went out under. A Salesperson changed on the
// Sales Order in Zoho is now mirrored onto the order and shown in its trail,
// by the same webhook and reconcile paths as every field above.

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
  },
  {
    key: 'salesperson',
    label: 'Salesperson',
    localColumn: 'salesperson',
    zohoValue: (so) => so.salesperson_name ?? null,
    // An order with no Salesperson stored locally (raised before Sep 5, or
    // adopted before the import recorded it) is LEARNING Zoho's value, not
    // seeing an edit. Written, but not reported — see `baseline` below.
    baselineWhenBlank: true,
    // Zoho answering with no Salesperson never blanks a stored one: it is
    // mandatory on every Sales Order here, so a missing value is a partial
    // response, not somebody clearing the field.
    ignoreBlankRemote: true
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
    if (oldValue === newValue) continue;
    if (newValue === null && field.ignoreBlankRemote) continue;
    changes.push({
      key: field.key,
      label: field.label,
      localColumn: field.localColumn,
      oldValue,
      newValue,
      // Sep 11, 2026: true when Zoho's value is filling a column this app
      // never stored, rather than replacing one. Callers write it but leave it
      // out of the trail and notifications — an "edit" nobody made is noise.
      baseline: oldValue === null && !!field.baselineWhenBlank
    });
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
