/**
 * Which Dispatch person caters (has taken on) an order.
 *
 * Sep 15, 2026. Several people work the Dispatch queue, and nothing said who
 * was handling which order, so two could prepare the same one. A Dispatch
 * person now "caters" an order: it shows as theirs everywhere, their "My
 * orders" lists it, and the others can pick up the ones nobody has.
 *
 * Confirmed with the business: a label, not a lock — the others still see and
 * can act on it; catering it themselves takes it over, and the trail says from
 * whom.
 *
 * Kept as order events (DISPATCH_CATERED / DISPATCH_RELEASED, the latest one
 * counts) rather than a column: no migration, and the history of who had it
 * comes with it. Unrelated to orders.action_claim, which is a few-second lock
 * around a single Zoho write (services/orderClaimService.js).
 */

/**
 * The orders someone currently caters: the latest cater/release entry per
 * order, when that entry is a cater. Append `AND last.actor_id = ?` for one
 * person's. Postgres DISTINCT ON; matched as one set, not probed per row.
 */
const CATERED_SUBQUERY = `
  SELECT last.order_id FROM (
    SELECT DISTINCT ON (ce2.order_id) ce2.order_id, ce2.event_type, ce2.actor_id
      FROM order_events ce2
     WHERE ce2.event_type IN ('DISPATCH_CATERED', 'DISPATCH_RELEASED')
     ORDER BY ce2.order_id, ce2.id DESC
  ) last
  WHERE last.event_type = 'DISPATCH_CATERED'`;

module.exports = { CATERED_SUBQUERY };
