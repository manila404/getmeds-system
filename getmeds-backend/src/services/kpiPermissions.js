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

/**
 * Oct 9, 2026 (Aaron): what the SALES TEAMS see is a separate switch that Admin flips on the
 * Sales KPIs page, so the company admins can review the numbers first.
 *   'admin_only' = "In progress": only Admin sees KPIs; My KPIs is hidden for everyone else.
 *   'everyone'   = MedReps, Leaders, Team Leaders and Managers see My KPIs.
 * Stored in the existing sync_state key/value table (no database change). Missing = 'admin_only',
 * so it starts hidden. Each server instance keeps the value 30 seconds, so a change reaches
 * everyone within about half a minute (they see it on their next page load).
 */
const { getSyncState, setSyncState } = require('./syncState');
const VISIBILITY_KEY = 'kpi_sales_visibility';
const VISIBILITY_LOG_KEY = 'kpi_sales_visibility_changed';
const VISIBILITY = ['admin_only', 'everyone'];
let visCache = { at: 0, value: null };

async function salesVisibility() {
  if (visCache.value && Date.now() - visCache.at < 30000) return visCache.value;
  const v = await getSyncState(VISIBILITY_KEY);
  visCache = { at: Date.now(), value: v === 'everyone' ? 'everyone' : 'admin_only' };
  return visCache.value;
}

async function setSalesVisibility(value, actor) {
  if (!VISIBILITY.includes(value)) throw new Error(`visibility must be one of: ${VISIBILITY.join(', ')}`);
  await setSyncState(VISIBILITY_KEY, value);
  await setSyncState(VISIBILITY_LOG_KEY, JSON.stringify({ value, by: actor?.name || actor?.email || null, at: new Date().toISOString() }));
  visCache = { at: Date.now(), value };
}

async function salesVisibilityChange() {
  try { return JSON.parse((await getSyncState(VISIBILITY_LOG_KEY)) || 'null'); } catch { return null; }
}

/** Sees My KPIs right now: a salesperson or team lead, AND Admin has turned KPIs on for them. */
async function canSeeOwnKpisNow(user) {
  return canViewOwnKpis(user) && (await salesVisibility()) === 'everyone';
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

module.exports = {
  isKpiPageEnabled, canViewAllKpis, canViewOwnKpis, canSeeOwnKpisNow, canSetAnyTarget, canSetTarget, TARGET_ROLES,
  salesVisibility, setSalesVisibility, salesVisibilityChange, VISIBILITY,
  _resetVisibilityCache: () => { visCache = { at: 0, value: null }; }
};
