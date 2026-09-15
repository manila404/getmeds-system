/**
 * Dispatch's warehouses, and which orders each one handles.
 *
 * Sep 15, 2026. Dispatch filters its page by warehouse. These are business
 * channels, NOT Zoho warehouses (Zoho's are Getmeds Philippines Inc., CEBU,
 * DAVAO, CONSIGNMENT and the HOMESTOCKS).
 *
 * Confirmed with the business (second version, same day):
 *
 *   BID                    BID
 *   CLIDP                  CLIDP
 *   RX                     B&B, STC, HOS, MSA, URO
 *   B2B                    B2B
 *   Anesthesia Telesales   TeleSales Anesthesia
 *   MD Telesales           MD Telesales, and plain TeleSales
 *   B2C                    B2C
 *   PAP                    by SOURCE, not division: PCSO, IAPF, DSWD,
 *                          Office of the President
 *   Unassigned             everything else — no division (mostly old
 *                          imports), PS, Management
 *
 * Every order is in exactly one. A PAP order also has a division, and PAP
 * takes precedence: it shows under PAP only, not under its division too.
 * Imported Zoho orders carry no Source, so they are never PAP.
 *
 * To move something, change it here; the page reads the result.
 */
const PAP_SOURCES = ['PCSO', 'IAPF', 'DSWD', 'Office of the President'];

const WAREHOUSES = [
  { key: 'bid', label: 'BID', divisions: ['BID'] },
  { key: 'clidp', label: 'CLIDP', divisions: ['CLIDP'] },
  { key: 'rx', label: 'RX', divisions: ['B&B', 'STC', 'HOS', 'MSA', 'URO'] },
  { key: 'b2b', label: 'B2B', divisions: ['B2B'] },
  { key: 'anesthesia', label: 'Anesthesia Telesales', divisions: ['TeleSales Anesthesia'] },
  { key: 'md_telesales', label: 'MD Telesales', divisions: ['MD Telesales', 'TeleSales'] },
  { key: 'b2c', label: 'B2C', divisions: ['B2C'] },
  { key: 'pap', label: 'PAP', sources: PAP_SOURCES }
];
const UNASSIGNED = { key: 'unassigned', label: 'Unassigned' };
const MAPPED_DIVISIONS = WAREHOUSES.flatMap((w) => w.divisions || []);

/** The warehouse an order belongs to, from its source and division. */
function warehouseOf(division, source) {
  if (source && PAP_SOURCES.includes(source)) return { key: 'pap', label: 'PAP' };
  const w = WAREHOUSES.find((x) => (x.divisions || []).includes(division));
  return w ? { key: w.key, label: w.label } : { key: UNASSIGNED.key, label: UNASSIGNED.label };
}

/**
 * The WHERE fragment for ?warehouse=, as { sql, params } — or null for "all"
 * or an unknown key. Parameters are arrays (ANY(?)).
 */
function warehouseSql(key, alias = 'o') {
  const notPap = `(${alias}.intake_source IS NULL OR NOT (${alias}.intake_source = ANY(?)))`;
  if (key === 'pap') return { sql: `${alias}.intake_source = ANY(?)`, params: [PAP_SOURCES] };
  const w = WAREHOUSES.find((x) => x.key === key && x.divisions);
  if (w) return { sql: `(${alias}.division = ANY(?) AND ${notPap})`, params: [w.divisions, PAP_SOURCES] };
  if (key === UNASSIGNED.key) {
    return {
      sql: `((${alias}.division IS NULL OR NOT (${alias}.division = ANY(?))) AND ${notPap})`,
      params: [MAPPED_DIVISIONS, PAP_SOURCES]
    };
  }
  return null;
}

module.exports = { WAREHOUSES, UNASSIGNED, PAP_SOURCES, warehouseOf, warehouseSql };
