'use strict';

/**
 * Canonical CSP (Customer-Specific / Non-Stocked Product) catalog derived from
 * the Sales Field Team Price List ("CSP Price List" tab).
 *
 * CSP is a product-level attribute rather than a customer category: orders
 * containing CSP items still sync Hub -> Zoho as Sales Orders, but Dispatch
 * must skip printing the Sales Order and must not block fulfillment on
 * physical warehouse batch picking for CSP lines.
 */
const CSP_CATALOG_ENTRIES = Object.freeze([
  { molecule: 'Adagrasib', strength: '200 mg', form: 'Tablet', packSize: "Box of 42's" },
  { molecule: 'Anti D', strength: '300mcg/ml', form: 'Solution for Injection', packSize: "Box of 1's" },
  { molecule: 'Avatrombopag', strength: '20 mg', form: 'Tablet', packSize: "Box of 28's" },
  { molecule: 'Azacitidine', strength: '300 mg', form: 'Tablet', packSize: "Bottle of 14's" },
  { molecule: 'Azacitidine', strength: '200 mg', form: 'Tablet', packSize: "Bottle of 14's" },
  { molecule: 'Cabozantinib', strength: '20 mg', form: 'Tablet', packSize: "Bottle of 30's" },
  { molecule: 'Cabozantinib', strength: '40 mg', form: 'Tablet', packSize: "Bottle of 30's" },
  { molecule: 'Cabozantinib', strength: '60 mg', form: 'Tablet', packSize: "Bottle of 30's" },
  { molecule: 'Carmustine', strength: '100 mg', form: 'Solution for IV Infusion + Diluent', packSize: "Box of 1's" },
  { molecule: 'Chlorambucil', strength: '2 mg', form: 'Tablet', packSize: "Box of 30's" },
  { molecule: 'Cidofovir', strength: '375 mg/5 ml', form: 'Solution for IV Infusion', packSize: "Bottle of 1's" },
  { molecule: 'Cladribine', strength: '10 mg', form: 'Solution for IV Infusion', packSize: "Box of 1's" },
  { molecule: 'Enasidenib', strength: '50 mg', form: 'Tablet', packSize: "Box of 30's" },
  { molecule: 'Erdafitinib', strength: '4 mg', form: 'Tablet', packSize: "Box of 28's" },
  { molecule: 'Fruquintinib', strength: '5 mg', form: 'Capsule', packSize: "Box of 21's" },
  { molecule: 'Giltertinib', strength: '40 mg', form: 'Tablet', packSize: "Bottle of 90's" },
  { molecule: 'Ivosidenib', strength: '250 mg', form: 'Tablet', packSize: "Box of 60's" },
  { molecule: 'Levosemindan', strength: '12.5mg', form: 'Solution for Injection', packSize: "Box of 1's" },
  { molecule: 'Midostaurin', strength: '25 mg', form: 'Capsule', packSize: "Bottle of 28's" },
  { molecule: 'Mitotane', strength: '500 mg', form: 'Tablet', packSize: "Bottle of 100's" },
  { molecule: 'Mitoxantrone', strength: '2 mg/ml (20 mg/10 ml)', form: 'Solution for IV Infusion', packSize: "Box of 1's" },
  { molecule: 'Mobocertinib', strength: '40 mg', form: 'Capsule', packSize: "Bottle of 60's" },
  { molecule: 'Niraparib', strength: '100 mg', form: 'Capsule', packSize: "Bottle of 30's" },
  { molecule: 'Nivolumab', strength: '40 mg', form: 'Solution for IV Infusion', packSize: "Box of 1's" },
  { molecule: 'Nivolumab', strength: '100 mg', form: 'Solution for IV Infusion', packSize: "Box of 1's" },
  { molecule: 'Pirfenidone', strength: '200 mg', form: 'Tablet', packSize: "Box of 10's" },
  { molecule: 'Selinexor', strength: '20 mg', form: 'Tablet', packSize: "Bottle of 16's" },
  { molecule: 'Sotorasib', strength: '120 mg', form: 'Tablet', packSize: "Bottle of 56's" },
  { molecule: 'Talazoparib', strength: '1 mg', form: 'Capsule', packSize: "Box of 30's" },
  { molecule: 'Tucatinib', strength: '150 mg', form: 'Tablet', packSize: "Bottle of 30's" },
  { molecule: 'Venetoclax', strength: '100 mg', form: 'Tablet', packSize: "Bottle of 60's" }
]);

// Include common INN spelling variants (e.g. Gilteritinib/Giltertinib, Levosimendan/Levosemindan)
const CSP_MOLECULE_PATTERNS = Object.freeze([
  'adagrasib',
  'anti d',
  'anti-d',
  'avatrombopag',
  'azacitidine',
  'cabozantinib',
  'carmustine',
  'chlorambucil',
  'cidofovir',
  'cladribine',
  'enasidenib',
  'erdafitinib',
  'fruquintinib',
  'giltertinib',
  'gilteritinib',
  'ivosidenib',
  'levosemindan',
  'levosimendan',
  'midostaurin',
  'mitotane',
  'mitoxantrone',
  'mobocertinib',
  'niraparib',
  'nivolumab',
  'pirfenidone',
  'selinexor',
  'sotorasib',
  'talazoparib',
  'tucatinib',
  'venetoclax'
]);

/**
 * Check whether a product name matches one of the known CSP molecules.
 * Uses boundary-aware matching so short prefixes never produce false positives.
 */
function isKnownCspProductName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  return CSP_MOLECULE_PATTERNS.some((pattern) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(normalized);
  });
}

module.exports = {
  CSP_CATALOG_ENTRIES,
  CSP_MOLECULE_PATTERNS,
  isKnownCspProductName
};
