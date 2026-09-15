/**
 * Dispatch's three warehouses, and which orders each one handles.
 *
 * Sep 15, 2026. Dispatch works from three warehouses — "Bidding CLIDP
 * Medrep", "RX(Patients) B2C" and "B2B Telesales PAPS" — and asked to filter
 * the Dispatch page by them. These are NOT Zoho warehouses (Zoho's are
 * Getmeds Philippines Inc., CEBU, DAVAO, CONSIGNMENT and the HOMESTOCKS); they
 * are business channels.
 *
 * Confirmed with the business: sorted by the order's DIVISION, which every
 * order carries, imported Zoho history included — so the filter works on all
 * of them without anyone tagging anything. An order with no division (mostly
 * old imports), or one outside these lists ("Management"), is "Unassigned".
 *
 * To move a division to another warehouse, change it here; the page reads
 * the result.
 */
const WAREHOUSES = [
  {
    key: 'bidding',
    label: 'Bidding CLIDP Medrep',
    // Bidding, CLIDP, and the field MedRep divisions.
    divisions: ['BID', 'CLIDP', 'HOS', 'STC', 'URO', 'B&B', 'MSA']
  },
  {
    key: 'rx',
    label: 'RX(Patients) B2C',
    divisions: ['B2C', 'PS']
  },
  {
    key: 'b2b',
    label: 'B2B Telesales PAPS',
    divisions: ['B2B', 'TeleSales', 'MD Telesales', 'TeleSales Anesthesia']
  }
];
const UNASSIGNED = { key: 'unassigned', label: 'Unassigned', divisions: [] };
const MAPPED_DIVISIONS = WAREHOUSES.flatMap((w) => w.divisions);

/** The warehouse an order belongs to, from its division. */
function warehouseOf(division) {
  const w = WAREHOUSES.find((x) => x.divisions.includes(division));
  return w ? { key: w.key, label: w.label } : { key: UNASSIGNED.key, label: UNASSIGNED.label };
}

/**
 * The WHERE fragment for ?warehouse=, as { sql, params } — or null for "all"
 * or an unknown key. Each carries one array parameter (ANY(?)).
 */
function warehouseSql(key, alias = 'o') {
  const w = WAREHOUSES.find((x) => x.key === key);
  if (w) return { sql: `${alias}.division = ANY(?)`, params: [w.divisions] };
  if (key === UNASSIGNED.key) {
    return { sql: `(${alias}.division IS NULL OR NOT (${alias}.division = ANY(?)))`, params: [MAPPED_DIVISIONS] };
  }
  return null;
}

module.exports = { WAREHOUSES, UNASSIGNED, warehouseOf, warehouseSql };
