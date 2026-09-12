/**
 * The stages Finance reads an order by.
 *
 * Sep 12, 2026. Mirrors services/financeStages.js on the server, which is what
 * `stats` in the queue response is keyed by, and what `?stage=` is validated
 * against. The KEYS are the contract; the labels are ours to word.
 *
 * One list because three things now render it — the dashboard cards, the
 * sidebar's "Finance Confirmation" group, and the heading that says which
 * filter is active. The attachment-type list taught this lesson already: three
 * copies drifted, and a Guarantee Letter ended up described as "Other".
 *
 * `navLabel` exists because the sidebar is narrow and the cards are not.
 * "Awaiting your confirmation" is right on a dashboard card and too long for a
 * nav item, but they must stay obviously the same thing — so the short form is
 * a trim of the long one, never a different word for it.
 */
export const FINANCE_STAGES = [
  {
    key: 'actionable',
    label: 'Awaiting your confirmation',
    navLabel: 'Awaiting confirmation',
    sub: 'Only you can clear these',
  },
  {
    key: 'upstream',
    label: 'Not yet with Finance',
    navLabel: 'Not yet with Finance',
    sub: 'Still with the MedRep or Zoho',
  },
  {
    key: 'invoicing',
    label: 'Invoicing in Zoho',
    navLabel: 'Invoicing in Zoho',
    sub: 'Confirmed, being invoiced',
  },
  {
    key: 'fulfilling',
    label: 'In fulfilment',
    navLabel: 'In fulfilment',
    sub: 'Packing and on the road',
  },
  {
    key: 'completed',
    label: 'Completed',
    navLabel: 'Completed',
    sub: 'Delivered and closed',
  },
  {
    key: 'exceptions',
    label: 'Needs attention',
    navLabel: 'On hold & exceptions',
    sub: 'On hold, cancelled or in exception',
  },
];

/** Falls back rather than throwing: an unknown key is a hand-edited URL. */
export const financeStageLabel = (key) =>
  (FINANCE_STAGES.find((s) => s.key === key) || {}).label || null;
