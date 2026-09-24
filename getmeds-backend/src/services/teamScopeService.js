'use strict';

const db = require('../db/database');

/**
 * Which orders — and, as of Sep 22, 2026, which MedReps — a 'team_lead'
 * user is allowed to reach. `teamMedrepIds`/`teamScopeSql` are also now the
 * scoping source orders.controller.js's `resolveOrderMedrep`/`getMedreps`
 * use to restrict who a team lead may raise an order FOR, not only what
 * they may look at — same list, same fail-closed rule, one source of truth
 * for "whose team is this" either way.
 *
 * ── A DIFFERENT SHAPE OF SCOPE, DELIBERATELY SEPARATE ───────────────────────
 *
 * Sep 21, 2026. Management's visibility (orderScopeService.js) is
 * division/sub_division-scoped: a manager is granted one or more divisions,
 * and sees every order stamped with them, regardless of which MedRep raised
 * it. A Team Lead's "team" is the opposite shape — specific MedReps assigned
 * to them (users.team_lead_id, set on the MedRep's own row), regardless of
 * which division those MedReps happen to be in. Tangling a person-based rule
 * into orderScopeService's division-shaped queries would make both harder to
 * read and easier to break; this is the parallel, single-purpose home for it.
 *
 * ── FAIL CLOSED, SAME AS A SCOPED MANAGER WITH NO RULES ─────────────────────
 *
 * A Team Lead with no MedReps assigned sees nothing — never every order.
 * There is no 'all' mode here at all: unlike order_scope's opt-in fail-open
 * default (which exists only because it needed to be safe to add to
 * management accounts that already had full access), 'team_lead' is a brand
 * new role with no prior access to preserve, so there is nothing to default
 * open for.
 *
 * ── WHAT "THEIR ORDER" MEANS ─────────────────────────────────────────────────
 *
 * `orders.medrep_id` — the order's actual owner/credited rep — of anyone on
 * the team, PLUS the Team Lead's own orders: ones they raised (raised_by_id)
 * and ones that are theirs outright (medrep_id is them).
 *
 * Sep 24, 2026: the own-orders half is new. Before it, "their order" meant
 * only a teammate's, which sounds complete until a Team Lead creates an order
 * for THEMSELVES (medrep_id = the lead, who is not on their own team): the
 * order fell outside every check here, so the person who had just created it
 * could not open it, edit it or submit it (403 "not raised by anyone on your
 * team"). Being able to create an order and not finish it is not a permission
 * anyone meant to grant.
 *
 * SEEING is what this file decides — team-wide, for the team's orders. Being
 * allowed to CHANGE one is narrower and lives in orders.controller.js's
 * canEditOrder: only the lead's own.
 */

/** This Team Lead's assigned MedRep user ids. Empty array, never null. */
async function teamMedrepIds(teamLeadUserId) {
  if (!teamLeadUserId) return [];
  const rows = await db.prepare('SELECT id FROM users WHERE team_lead_id = ?').all(teamLeadUserId);
  return rows.map((r) => r.id);
}

/**
 * A SQL fragment restricting a query to this Team Lead's team, as
 * `{ sql, params }` — same return shape as orderScopeService.scopeSql, so a
 * caller can swap between the two without changing how the result is used.
 *
 * `alias` is the orders table's alias in the calling query.
 */
async function teamScopeSql(teamLeadUserId, alias = 'o') {
  const ids = await teamMedrepIds(teamLeadUserId);
  // Fails closed: no user id at all means no orders, not all orders.
  if (!teamLeadUserId) return { sql: '1 = 0', params: [] };

  // The lead's own orders are always in scope; a teammate's join them when the
  // lead has a team. No assigned MedReps still fails closed for everyone
  // else's orders — this clause matches only orders that are the lead's own.
  const own = `${alias}.medrep_id = ? OR ${alias}.raised_by_id = ?`;
  if (!ids.length) return { sql: `(${own})`, params: [teamLeadUserId, teamLeadUserId] };

  const placeholders = ids.map(() => '?').join(', ');
  return {
    sql: `(${alias}.medrep_id IN (${placeholders}) OR ${own})`,
    params: [...ids, teamLeadUserId, teamLeadUserId]
  };
}

/** Does this Team Lead's scope cover this one order? */
async function canAccessOrder(user, order) {
  if (!user || !order) return false;
  // Their own — raised by them, or theirs outright.
  if (order.medrep_id === user.id || order.raised_by_id === user.id) return true;
  if (!order.medrep_id) return false;
  const ids = await teamMedrepIds(user.id);
  return ids.includes(order.medrep_id);
}

module.exports = {
  teamMedrepIds,
  teamScopeSql,
  canAccessOrder
};
