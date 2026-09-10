'use strict';

/**
 * Turning an order's raw events into something a person can read at a glance.
 *
 * Sep 10, 2026 (2c). ZOHO-SO-67262 had 20 trail rows for an order that did six
 * things. 2b removed the noise and the duplicates; this decides what the
 * remaining rows MEAN, so the screen can show a short pipeline by default and
 * the detail only when asked for.
 *
 * ── ONE SPINE FOR BOTH FLOWS ────────────────────────────────────────────────
 *
 * The system has to hold two kinds of order at once, and they must read the
 * same way:
 *
 *   OLD (the present)  raised in Zoho, fulfilled in Zoho, imported here
 *   NEW (GM-)          raised here, approved and verified here, fulfilled in Zoho
 *
 * They share stages 3-10, because both are fulfilled in Zoho. Only APPROVED
 * and VERIFIED differ, and rather than hide them for imported orders they are
 * shown as 'not_applicable' with the reason — an imported order was verified
 * on the Google chat thread, and a stage that silently vanishes is
 * indistinguishable from a control that was skipped.
 *
 * ── TWO SOURCES OF TRUTH, AND WHY BOTH ARE NEEDED ───────────────────────────
 *
 * Sep 10, 2026 (3b). A stage can be satisfied two ways:
 *
 *   an EVENT  something happened, and we know when and by whom
 *   the STATE Zoho's four status axes say it is currently true
 *
 * Events alone were not enough. SO-59373 shipped via Lalamove on 31 Jan with
 * no tracking number, so the reconcile never recorded a shipment (see 3a) —
 * and the pipeline, reading only events, showed "Shipped: pending" while the
 * order header said Dispatched. An order contradicting itself on one screen.
 * Across the org that was 58,824 orders.
 *
 * State evidence fixes every one of them with no API calls, because the axes
 * arrive free with the list walk. But it is WEAKER evidence and is presented
 * as such: a state-satisfied stage carries no timestamp and no person, because
 * Zoho's `shipped_status` says THAT it shipped and never when or by whom.
 * Inventing a time would make the trail look precise and be wrong — the exact
 * failure this whole effort started from.
 *
 * An event always wins where both exist, and history passes progressively
 * upgrade state-satisfied stages into real, timestamped, attributed ones.
 *
 * ── THREE TIERS ─────────────────────────────────────────────────────────────
 *
 *   milestone  the ten spine stages. Always visible. One row each.
 *   update     real changes that are not stage transitions — edits, returns,
 *              reversals, attachments, holds. Collapsed under the stage they
 *              follow, as "N updates".
 *   system     automation. Nothing writes these any more (see
 *              zohoHistoryService) and 2b removed the legacy ones, but the
 *              tier is kept so anything that slips through is classified
 *              rather than shown as a milestone.
 *
 * Anything UNKNOWN is treated as an update, never dropped. The same reasoning
 * as the history classifier: an unrecognised event is one nobody has read yet,
 * and hiding it is how Sales Returns went unnoticed for a week.
 */

/**
 * The canonical pipeline, in the order the business thinks about it.
 *
 * `types` are the event types that SATISFY the stage, in PREFERENCE order —
 * the first type present wins, not the earliest event.
 *
 * That distinction matters. An imported order has both ORDER_IMPORTED_FROM_ZOHO
 * ("this app found the order") and ZOHO_SO_CREATED ("Aman Bishnoi raised it"),
 * with identical timestamps. Picking the earliest put the bookkeeping entry on
 * the Created stage and demoted the real event, by the real person, to a
 * collapsed update — precisely backwards.
 *
 * Note this is a CHECKLIST order, not a strict chronology. In this org
 * customers are on terms, so payment routinely lands after shipping — showing
 * the stages in pipeline order with their real timestamps reads better than
 * re-sorting the pipeline itself on every order.
 */
const SPINE = [
  {
    key: 'created',
    label: 'Created',
    // Listed in PREFERENCE order, not chronological — see the note on
    // `types` above. ORDER_IMPORTED_FROM_ZOHO is last because it is this
    // app's bookkeeping ("we found this order"), not the business event; it
    // only fills the stage when nothing better exists.
    types: ['ORDER_CREATED', 'ZOHO_SO_CREATED', 'ORDER_SUBMITTED', 'ORDER_IMPORTED_FROM_ZOHO']
  },
  {
    key: 'approved',
    label: 'Management Approved',
    types: ['MANAGEMENT_APPROVED'],
    // Introduced by this app. An imported order never passed through it.
    appOnly: true,
    notApplicableNote: 'Not applicable — this order was raised in Zoho, before in-app approval existed.'
  },
  {
    key: 'confirmed',
    label: 'Confirmed',
    types: ['ZOHO_SO_CONFIRMED', 'ORDER_CONFIRMED'],
    // Anything past draft has been confirmed by definition.
    fromState: (o) =>
      !['', 'draft'].includes(String(o.zoho_order_status || '').toLowerCase()) ||
      ['confirmed', 'open', 'invoiced', 'shipped', 'partially_shipped', 'fulfilled', 'closed']
        .includes(String(o.zoho_so_status || '').toLowerCase())
  },
  {
    key: 'verified',
    label: 'Finance Verified',
    types: ['FINANCE_VERIFIED'],
    appOnly: true,
    // The wording the business asked for. Verification is real for these
    // orders — it happened on a Google chat thread — so this must not read as
    // a skipped control.
    notApplicableNote:
      'Verified on the Google chat thread, not in this app — this order predates in-app verification. ' +
      'Check the Google thread for the approval.'
  },
  {
    key: 'invoiced',
    label: 'Invoiced',
    types: ['ZOHO_INVOICE_SENT', 'ZOHO_INVOICE_DRAFTED'],
    fromState: (o) =>
      ['invoiced', 'partially_invoiced'].includes(String(o.zoho_invoiced_status || '').toLowerCase())
  },
  {
    key: 'paid',
    label: 'Paid',
    types: ['ZOHO_PAYMENT_VERIFIED', 'PAYMENT_VERIFIED'],
    fromState: (o) => String(o.zoho_paid_status || '').toLowerCase() === 'paid'
  },
  {
    key: 'packed',
    label: 'Packed',
    types: ['ZOHO_PACKAGE_CREATED'],
    // Shipped implies packed — goods cannot leave unpacked.
    fromState: (o) =>
      ['shipped', 'partially_shipped', 'fulfilled'].includes(String(o.zoho_shipped_status || '').toLowerCase())
  },
  {
    key: 'shipped',
    label: 'Shipped',
    types: ['ZOHO_DISPATCHED', 'ORDER_DISPATCHED', 'TRACKING_ENTERED'],
    fromState: (o) =>
      ['shipped', 'partially_shipped', 'fulfilled'].includes(String(o.zoho_shipped_status || '').toLowerCase())
  },
  {
    key: 'delivered',
    label: 'Delivered',
    types: ['ZOHO_DELIVERED'],
    // 'fulfilled' is Zoho's end state for the shipment axis and means the
    // goods reached the customer. 'shipped' alone does NOT — that is in
    // transit, and claiming delivery from it would be inventing a fact.
    fromState: (o) => String(o.zoho_shipped_status || '').toLowerCase() === 'fulfilled'
  },
  {
    key: 'completed',
    label: 'Completed',
    types: ['ORDER_COMPLETED', 'ZOHO_SO_FULFILLED'],
    fromState: (o) =>
      String(o.zoho_so_status || '').toLowerCase() === 'fulfilled' ||
      String(o.zoho_order_status || '').toLowerCase() === 'closed'
  }
];

/** eventType -> stage key, built once from SPINE so the two cannot drift. */
const STAGE_BY_TYPE = new Map();
for (const stage of SPINE) {
  for (const t of stage.types) STAGE_BY_TYPE.set(t, stage.key);
}

/**
 * Events that END an order without completing it. They get their own stage
 * slot rather than being buried as an update, because "this order was
 * cancelled" is the single most important thing about a cancelled order.
 */
const TERMINAL = {
  ORDER_CANCELLED: 'Cancelled',
  ZOHO_SO_CANCELLED: 'Cancelled in Zoho',
  ZOHO_SO_DELETED: 'Deleted in Zoho'
};

/** Automation. Nothing writes these now; kept so a stray one is classified. */
const SYSTEM_TYPES = new Set(['ZOHO_EVENT_RECEIVED']);

/** What tier does an event belong to? */
function tierOf(eventType) {
  if (STAGE_BY_TYPE.has(eventType)) return 'milestone';
  if (SYSTEM_TYPES.has(eventType)) return 'system';
  // Everything else, INCLUDING types this module has never seen, is an update.
  // Dropping the unrecognised is how a real event disappears.
  return 'update';
}

/** Did this come from Zoho's own record, or from something done in this app? */
function sourceOf(event) {
  try {
    if (JSON.parse(event.metadata || '{}').zohoCommentId) return 'zoho';
  } catch (_) {
    /* malformed metadata is not a reason to mislabel the source */
  }
  return String(event.event_type || '').startsWith('ZOHO_') ? 'zoho' : 'app';
}

/**
 * Build the pipeline view.
 *
 * @param {object} order  the order row — `getmeds_order_id` decides whether the
 *                        app-only stages apply.
 * @param {Array}  events the order's events, any order; sorted here.
 * @returns {{stages: Array, counts: object}}
 */
function buildTimeline(order, events = []) {
  const imported = String(order?.getmeds_order_id || '').startsWith('ZOHO-');

  const sorted = [...events].sort((a, b) => {
    const t = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    return t !== 0 ? t : (a.id || 0) - (b.id || 0);
  });

  // First event per stage wins. A stage reached twice — an order re-packed
  // after an un-shipment — keeps its ORIGINAL time, and the second occurrence
  // stays visible as an update, which is the honest reading of "when did this
  // order first get packed".
  const hit = new Map();
  const updates = [];
  const terminals = [];

  // Pick each stage's event by TYPE PREFERENCE first, then by time. Walking
  // the events in order and taking the first milestone per stage would let a
  // bookkeeping entry outrank the real one when they share a timestamp.
  const candidates = new Map(); // stage key -> { type -> earliest event }
  const rest = [];

  for (const e of sorted) {
    if (TERMINAL[e.event_type]) {
      terminals.push(e);
      continue;
    }
    const tier = tierOf(e.event_type);
    if (tier === 'system') continue;

    if (tier !== 'milestone') {
      rest.push(e);
      continue;
    }

    const key = STAGE_BY_TYPE.get(e.event_type);
    if (!candidates.has(key)) candidates.set(key, new Map());
    const byType = candidates.get(key);
    // Earliest of each type — `sorted` is ascending, so the first wins.
    if (!byType.has(e.event_type)) byType.set(e.event_type, e);
    else rest.push(e);
  }

  for (const stage of SPINE) {
    const byType = candidates.get(stage.key);
    if (!byType) continue;
    let chosen = null;
    for (const type of stage.types) {
      if (byType.has(type)) { chosen = byType.get(type); break; }
    }
    if (!chosen) chosen = [...byType.values()][0];
    hit.set(stage.key, chosen);
    // Every other milestone event for this stage stays visible as an update.
    for (const e of byType.values()) if (e !== chosen) rest.push(e);
  }

  updates.push(...rest);

  const stages = SPINE.map((stage) => {
    const event = hit.get(stage.key) || null;

    // Only consulted when no event recorded the stage — an event is strictly
    // better evidence and must never be overridden by the weaker kind.
    const byState = !event && typeof stage.fromState === 'function' && stage.fromState(order || {});
    const notApplicable = !event && !byState && stage.appOnly && imported;

    return {
      key: stage.key,
      label: stage.label,
      state: event ? 'done' : byState ? 'done' : notApplicable ? 'not_applicable' : 'pending',
      // How we know. 'event' carries a time and a person; 'state' carries
      // neither, and the UI says so rather than implying a precision Zoho did
      // not give us.
      evidence: event ? 'event' : byState ? 'state' : null,
      at: event ? event.created_at : null,
      by: event ? event.actor_name : null,
      source: event ? sourceOf(event) : byState ? 'zoho' : null,
      note: event
        ? event.notes
        : byState
          ? 'Confirmed by Zoho\u2019s current status. The exact time and person arrive when this order\u2019s Zoho history is pulled.'
          : notApplicable
            ? stage.notApplicableNote
            : null,
      event_type: event ? event.event_type : null,
      updates: []
    };
  });

  // Attach each update to the last stage that had already happened when it
  // occurred, so expanding a stage shows what changed AFTER it — the reading
  // that makes "3 updates" between Confirmed and Invoiced mean something.
  const done = stages.filter((s) => s.state === 'done');
  const byKey = new Map(stages.map((s) => [s.key, s]));

  for (const u of updates) {
    let target = done[0] || stages[0];
    for (const s of done) {
      if (String(s.at || '') <= String(u.created_at || '')) target = s;
    }
    byKey.get(target.key).updates.push({
      id: u.id,
      event_type: u.event_type,
      at: u.created_at,
      by: u.actor_name,
      note: u.notes,
      source: sourceOf(u)
    });
  }

  // A cancelled or deleted order is not "pending everything else". Say what
  // actually happened, at the end, where the eye lands last.
  for (const t of terminals) {
    stages.push({
      key: 'terminal',
      label: TERMINAL[t.event_type],
      state: 'terminal',
      at: t.created_at,
      by: t.actor_name,
      source: sourceOf(t),
      note: t.notes,
      event_type: t.event_type,
      updates: []
    });
  }

  return {
    stages,
    counts: {
      total: events.length,
      milestones: hit.size,
      updates: updates.length,
      reached: stages.filter((s) => s.state === 'done').length,
      // How much of the progress is precise vs merely known to be true.
      from_events: stages.filter((s) => s.evidence === 'event').length,
      from_state: stages.filter((s) => s.evidence === 'state').length,
      of: SPINE.length
    }
  };
}

module.exports = { buildTimeline, tierOf, sourceOf, SPINE, STAGE_BY_TYPE, TERMINAL };
