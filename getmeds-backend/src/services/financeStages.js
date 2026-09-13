/**
 * How Finance reads an order's status.
 *
 * Sep 12, 2026. Finance now sees the same orders a MedRep sees, at every
 * stage, rather than only the four statuses they can act on. That needs a
 * vocabulary, because the raw status list answers "where is this order in the
 * pipeline" and Finance is asking something narrower: "is this mine yet, is it
 * mine now, or is it done with me".
 *
 * So the groups below are not a re-cut of the workflow. They are that one
 * question, and only ACTIONABLE contains anything Finance can do something
 * about -- everything else is context, shown so an order does not vanish
 * between the moment a MedRep submits it and the moment it lands here.
 *
 * Kept out of the controller because the frontend's cards, its filter chips
 * and the stats query all have to agree on which statuses mean what. Three
 * copies of that mapping is how the attachment-type list drifted.
 */

// The one group Finance acts on. Verify lives here and nowhere else.
const ACTIONABLE = ['ready_for_finance_verified'];

// Submitted, but not yet Finance's problem.
const UPSTREAM = [
  'draft',
  'pending_management_approval',
  'submitted',
  'validating',
  'so_pending',
  'so_created',
];

// Confirmed by Finance; the invoice is being raised in Zoho.
const INVOICING = ['ready_for_draft_invoice', 'ready_for_invoice_sent'];

// Past Finance entirely -- moving toward the customer.
const FULFILLING = ['ready_for_dispatch', 'picking_packing', 'dispatched', 'tracking_shared'];

const COMPLETED = ['completed'];

// Needs a human, not necessarily this one. Surfaced as a banner rather than a
// card, the way the MedRep dashboard does it.
const EXCEPTIONS = ['on_hold', 'exception', 'cancelled', 'deleted'];

/**
 * Order matters: the frontend renders cards in this sequence, left to right,
 * and it reads as a pipeline. Actionable first because it is the only column
 * anyone has to do anything about.
 */
const STAGE_GROUPS = [
  { key: 'actionable', label: 'Awaiting your confirmation', statuses: ACTIONABLE },
  { key: 'upstream',   label: 'Not yet with Finance',       statuses: UPSTREAM },
  { key: 'invoicing',  label: 'Invoicing in Zoho',          statuses: INVOICING },
  { key: 'fulfilling', label: 'In fulfilment',              statuses: FULFILLING },
  { key: 'completed',  label: 'Completed',                  statuses: COMPLETED },
  { key: 'exceptions', label: 'Needs attention',            statuses: EXCEPTIONS },
];

/** Every status a group claims, for validating a ?stage= filter. */
const ALL_GROUPED = STAGE_GROUPS.flatMap((g) => g.statuses);

/** The statuses behind a stage key, or [] for one that does not exist. */
function statusesForStage(stage) {
  const g = STAGE_GROUPS.find((x) => x.key === String(stage || '').trim().toLowerCase());
  return g ? g.statuses : [];
}

module.exports = {
  ACTIONABLE,
  UPSTREAM,
  INVOICING,
  FULFILLING,
  COMPLETED,
  EXCEPTIONS,
  STAGE_GROUPS,
  ALL_GROUPED,
  statusesForStage,
};
