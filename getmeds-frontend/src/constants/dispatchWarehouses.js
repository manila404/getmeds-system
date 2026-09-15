/**
 * The Dispatch page's warehouse filter (Sep 15, 2026).
 *
 * The server decides which orders fall in each — by Division, and PAP by
 * Source — see the backend's services/dispatchWarehouses.js, the authority.
 * This is only the tabs to draw, with what each holds as a hint. Keep the
 * keys in step.
 */
export const DISPATCH_WAREHOUSES = [
  { key: '', label: 'All warehouses' },
  { key: 'bid', label: 'BID', hint: 'Division BID' },
  { key: 'clidp', label: 'CLIDP', hint: 'Division CLIDP' },
  { key: 'rx', label: 'RX', hint: 'B&B, STC, HOS, MSA, URO' },
  { key: 'b2b', label: 'B2B', hint: 'Division B2B' },
  { key: 'anesthesia', label: 'Anesthesia Telesales', hint: 'Division TeleSales Anesthesia' },
  { key: 'md_telesales', label: 'MD Telesales', hint: 'MD Telesales and TeleSales' },
  { key: 'b2c', label: 'B2C', hint: 'Division B2C' },
  { key: 'pap', label: 'PAP', hint: 'Source PCSO, IAPF, DSWD or Office of the President' },
  { key: 'unassigned', label: 'Unassigned', hint: 'No division, or one outside these (PS, Management)' }
];
