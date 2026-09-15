/**
 * The Dispatch page's warehouse filter (Sep 15, 2026).
 *
 * The server decides which orders fall in each (by Division — see the
 * backend's services/dispatchWarehouses.js, the authority); this is only the
 * tabs to draw, with the divisions shown as a hint. Keep the keys in step.
 */
export const DISPATCH_WAREHOUSES = [
  { key: '', label: 'All warehouses' },
  { key: 'bidding', label: 'Bidding CLIDP Medrep', hint: 'BID, CLIDP, HOS, STC, URO, B&B, MSA' },
  { key: 'rx', label: 'RX(Patients) B2C', hint: 'B2C, PS' },
  { key: 'b2b', label: 'B2B Telesales PAPS', hint: 'B2B, TeleSales, MD Telesales, TeleSales Anesthesia' },
  { key: 'unassigned', label: 'Unassigned', hint: 'No division, or one outside the three' }
];
