'use strict';

/**
 * Who may use the KPI page, and the switch that turns it on. Oct 5, 2026 (sheet 13.1.2).
 *
 * The switch: off unless GETMEDS_KPI_PAGE is exactly "true" — the same strict reading as
 * workflowFlags.js, so a typo leaves the page off. While it is off every /api/kpi route
 * answers 404 and the menu item is hidden. On Vercel a change to the variable takes effect
 * only after a redeploy (accepted by Aaron, Oct 5, 2026). Read at call time so tests can flip it.
 *
 * The rules: Admin only for now. Aaron wants Management and Team Leads to be able to set
 * targets for their own teams later, so every check goes through the functions below —
 * widening access is a change here, not in the routes or the page.
 */

const roleOf = (user) => String(user?.role || user?.role_name || '').toLowerCase();

function isKpiPageEnabled() {
  return (process.env.GETMEDS_KPI_PAGE || '').trim().toLowerCase() === 'true';
}

/** Sees every person's, team's, head's and channel's KPIs. */
function canViewAllKpis(user) {
  return roleOf(user) === 'admin';
}

/**
 * Sees their own KPIs (My Own KPI) and, for anyone with people under them, their team's
 * (My Team KPI). Oct 6, 2026: every salesperson, Leader, Team Leader and Manager (sheet 12.13).
 */
function canViewOwnKpis(user) {
  return ['medrep', 'team_lead'].includes(roleOf(user));
}

/** May set targets for anyone at all (decides whether the Set targets panel shows). */
function canSetAnyTarget(user) {
  return roleOf(user) === 'admin';
}

/**
 * May set this person's target. `person` is the users row (id, role, team_lead_id), kept
 * as a parameter so a later "Team Leads set their own team" rule needs no new call sites.
 */
// eslint-disable-next-line no-unused-vars
function canSetTarget(actor, person) {
  return roleOf(actor) === 'admin';
}

/** Roles that carry a sales target. */
const TARGET_ROLES = ['medrep', 'team_lead'];

module.exports = { isKpiPageEnabled, canViewAllKpis, canViewOwnKpis, canSetAnyTarget, canSetTarget, TARGET_ROLES };
