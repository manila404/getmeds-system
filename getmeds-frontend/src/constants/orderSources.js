/**
 * The order's "Source" — sent to Zoho's cf_source on the Sales Order.
 *
 * Sep 15, 2026. cf_source is a DROPDOWN in Zoho, and MANDATORY: a value that
 * is not exactly one of its options (case and spelling included) is not a
 * Source Zoho will take. So this list is Zoho's own, read from the org via
 * Zoho_Books list_custom_fields (entity=salesorder, field id
 * 2254168001929089177) the day it was written — all 12, in Zoho's order.
 *
 * One list for every screen. There were two, and they had drifted: the order
 * page offered six, and the order form offered "PAP-DSWD", which Zoho does not
 * have (it has DSWD and PCSO as separate options).
 *
 * When Zoho's options change, change this to match — and nothing else.
 */
export const ORDER_SOURCES = [
  'Doctor order',
  'Patient order referred by doctor',
  'Patient order referred by patient',
  'Emergency purchase',
  'Hospital PO',
  'Distributor order',
  'Bidding Order',
  'B2C Order',
  'PCSO',
  'IAPF',
  'DSWD',
  'Office of the President'
];
