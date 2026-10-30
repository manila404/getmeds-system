/**
 * Division and Sub-division lists for the screens that set them on an
 * ACCOUNT: Profile Settings and the admin's Create account form.
 *
 * Mirrors DIVISIONS and SUB_DIVISIONS_BY_DIVISION in the backend's
 * auth.controller.js exactly — see that file's comment for why Division is a
 * fixed list rather than free text. The backend is the authority; these exist
 * so a dropdown only offers what it will accept.
 *
 * Sep 11, 2026: moved here from ProfilePage.jsx and SignupPage.jsx when
 * sign-up was removed and the admin Users page needed the same lists. The
 * order screens (OrderForm.jsx, OrderDetailPage.jsx) still keep their own
 * copies.
 */

// Kept in the order given.
//
// Sep 9, 2026: '2MG Incorporated', 'Office of the President', 'PCSO', 'DSWD'
// and 'GrabMart' removed at the user's request. Verified against the live
// database first: no user and no order carried any of the five.
//
// Sep 10, 2026: 'TeleSales', 'MD Telesales' and 'PS' added — already in use in
// Zoho (found auditing the Salesperson strings on the imported Sales Orders),
// not new business units. Ordered after the original ten rather than
// alphabetically, so the diff reads as "three added" rather than a reshuffle.
export const DIVISIONS = [
  'B&B',
  'B2B',
  'B2C',
  'BID',
  'CLIDP',
  'HOS',
  'MSA',
  'STC',
  'TeleSales Anesthesia',
  'URO',
  'TeleSales',
  'MD Telesales',
  'PS',
  // Oct 30, 2026: Modern Trade (see the backend's auth.controller.js).
  'MT',
];

/**
 * Oct 30, 2026: the Division an order belongs to, from the Zoho Salesperson picked on it.
 * Mirrors the backend's services/salespersonDivision.js exactly (see its comment): the
 * primary name, or a name in the account's own family, keeps the account's Division;
 * another name whose prefix is a known Division ("MT | 1" -> "MT") takes that Division.
 */
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
export const salespersonPrefix = (name) => {
  const m = String(name || '').match(/^\s*(.+?)\s*(?:\||\sl\s)/);
  return m ? m[1].trim() : '';
};
export const divisionForSalesperson = ({ salesperson, primarySalesperson, accountDivision, divisions = DIVISIONS }) => {
  const account = accountDivision || null;
  if (!salesperson || lc(salesperson) === lc(primarySalesperson)) return account;
  const prefix = lc(salespersonPrefix(salesperson));
  if (!prefix) return account;
  if (account && lc(account).startsWith(prefix)) return account;
  return divisions.find((d) => lc(d) === prefix) || account;
};

// Only these four Divisions have named sub-divisions. Sep 9, 2026: offered as
// SUGGESTIONS (a datalist), never enforced — reps often cover several and the
// lists were never exhaustive, so sub-division is free text everywhere.
export const SUB_DIVISIONS_BY_DIVISION = {
  'B&B': ['CEBU', 'DAVAO', 'E. RODRIGUEZ', 'EAST AVE', 'NCL', 'SOUTH LUZON', 'TAFT'],
  HOS: [
    'GENSAN',
    'PALAWAN',
    'BAGUIO',
    'BICOL',
    'CABANATUAN',
    'CAMANAVA',
    'CAVITE',
    'CDO',
    'COMMONWEALTH',
    'DAVAO NORTH',
    'DAVAO SOUTH',
    'ILOILO',
    'LAGUNA',
    'LAS PINAS',
    'MANILA VACANT',
    'MARIKINA',
    'NORTH CEBU',
    'PAMPANGA',
    'PARANAQUE',
    'PASAY',
    'QUEZON PROVINCE',
    'SOUTH CEBU',
    'TUGUEGARAO',
    'ZAMBOANGA',
  ],
  STC: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
  URO: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
};
