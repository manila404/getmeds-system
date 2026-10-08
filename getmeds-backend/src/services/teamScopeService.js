'use strict';

const db = require('../db/database');
const { hasColumn } = require('./schemaColumns');

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

/**
 * This Team Lead's (or Channel Head's) full set of MedRep user ids.
 * Empty array, never null.
 *
 * Sep 29, 2026: extended for the Channel Head case.
 *
 * A Channel Head (e.g. Javed) sits in `sales_channels.head_user_id`, NOT as a
 * direct Team Lead on any MedRep row. The intermediate Team Lead (e.g. Honey)
 * is in `sales_managers.user_id` for that channel, and MedReps under Honey
 * have `team_lead_id = Honey's id`. So a single-level `WHERE team_lead_id = ?`
 * on Javed returns nothing — his team is a level further down.
 *
 * Two passes:
 *   1. Direct MedReps — `users.team_lead_id = this user` (original behaviour).
 *   2. Rolled-up MedReps — for every sales_channel where this user is
 *      head_user_id, include all MedReps whose team_lead_id is any
 *      sales_manager in that channel. This is exactly the "Head → TL → MedRep"
 *      chain the Admin org-chart shows without requiring any schema change.
 *
 * Both sets are merged and deduplicated before return.
 *
 * Oct 6, 2026: the whole chain, not one level (sales structure update, Aaron sheet
 * 12.13). The structure now has four levels: Manager > Team Leader > Leader > MedRep
 * (Javed > Honey > Shiela > Marwin Dy), all through users.team_lead_id. Everyone below
 * this user is on their team, at any depth, whatever their role, so Honey sees her
 * Leaders' MedReps and can raise an order for a Leader. Nobody beside or above is
 * included, so Shiela never sees Benjie's team. A loop in the settings (A leads B,
 * B leads A) cannot hang it: each person is visited once, and the walk stops after
 * MAX_DEPTH levels. The whole users table is read in one query (about 100 rows), so
 * this is one round trip whatever the depth.
 */
const MAX_DEPTH = 6;

async function teamMedrepIds(teamLeadUserId) {
  if (!teamLeadUserId) return [];

  const rows = await db.prepare('SELECT id, team_lead_id FROM users WHERE team_lead_id IS NOT NULL').all();
  const below = new Map();
  for (const r of rows) {
    if (!below.has(r.team_lead_id)) below.set(r.team_lead_id, []);
    below.get(r.team_lead_id).push(r.id);
  }

  // Channel headship (Sep 29): people whose Team Lead is a manager in a channel this user heads.
  const headRows = await db.prepare(`
    SELECT DISTINCT u.id
    FROM users u
    JOIN sales_managers sm ON sm.user_id = u.team_lead_id
    JOIN sales_channels sc ON sc.id = sm.channel_id
    WHERE sc.head_user_id = ?
  `).all(teamLeadUserId);

  const team = new Set();
  let level = [...(below.get(teamLeadUserId) || []), ...headRows.map((r) => r.id)];
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const id of level) {
      if (id === teamLeadUserId || team.has(id)) continue; // loop guard
      team.add(id);
      next.push(...(below.get(id) || []));
    }
    level = next;
  }
  return [...team];
}

/**
 * Oct 6, 2026 (sales structure, sheet 12.13): the tabs on My Team.
 *
 * One group per person directly under this user who has a team of their own
 * ("Shiela's team": Shiela plus everyone under her), and the people directly under
 * this user with no team, split by the channel of their territory ("My team: HOS",
 * "My team: Telesales"). So Vanessa, who leads Telesales and a HOS group herself and
 * has HOS Leaders under her, gets Telesales, HOS, and one tab per Leader; Honey gets
 * one tab per Leader plus her B2C reps. Every group is inside teamMedrepIds, so a tab
 * can only ever narrow what this user may see, never widen it.
 * Returns [] when there is nothing to split (one group would just repeat "All").
 */
// One label per channel, whether it comes from a territory ("RX · B&B", "HOSP") or, for
// someone with no territory, from their account's division ("TeleSales Anesthesia").
const channelLabel = (name) => {
  const n = String(name || '').replace(/^RX\s*\u00b7\s*/i, '').trim();
  if (/^hos(p(ital)?)?\b/i.test(n)) return 'HOS';
  if (/^(md\s*)?tele\s*sales/i.test(n)) return 'Telesales';
  return n;
};

async function teamGroups(teamLeadUserId) {
  if (!teamLeadUserId) return [];
  const team = new Set(await teamMedrepIds(teamLeadUserId));
  if (!team.size) return [];
  const titled = await hasColumn('users', 'sales_title');
  const users = await db.prepare(`SELECT id, name, team_lead_id, division${titled ? ', sales_title' : ''} FROM users WHERE team_lead_id IS NOT NULL`).all();
  const direct = users.filter((u) => u.team_lead_id === teamLeadUserId && team.has(u.id));
  // Each direct report's own channel, from the territory their primary Zoho Salesperson holds.
  const channels = await db.prepare(`
    SELECT us.user_id, c.name AS channel
      FROM user_salespersons us
      JOIN sales_territories t ON LOWER(TRIM(t.zoho_salesperson)) = LOWER(TRIM(us.salesperson))
                               OR LOWER(TRIM(COALESCE(t.zoho_alias, ''))) = LOWER(TRIM(us.salesperson))
      JOIN sales_managers m ON m.id = t.manager_id
      JOIN sales_channels c ON c.id = m.channel_id
     ORDER BY us.is_primary DESC`).all();
  const channelOf = new Map();
  for (const r of channels) if (!channelOf.has(r.user_id)) channelOf.set(r.user_id, channelLabel(r.channel));

  const groups = [];
  const mine = new Map();
  for (const u of direct) {
    const theirs = await teamMedrepIds(u.id);
    if (theirs.length) {
      groups.push({ key: `lead:${u.id}`, label: `${u.name}'s team`, title: u.sales_title || null, ids: [u.id, ...theirs.filter((id) => team.has(id))] });
    } else {
      const label = channelOf.get(u.id) || (u.division ? channelLabel(u.division) : 'Others');
      if (!mine.has(label)) mine.set(label, []);
      mine.get(label).push(u.id);
    }
  }
  const myGroups = [...mine.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, ids]) => ({ key: `mine:${label}`, label: mine.size > 1 || groups.length ? `My team: ${label}` : 'My team', ids }));
  const all = [...myGroups, ...groups.sort((a, b) => a.label.localeCompare(b.label))];
  return all.length > 1 ? all : [];
}

/**
 * A SQL fragment restricting a query to this Team Lead's team, as
 * `{ sql, params }` — same return shape as orderScopeService.scopeSql, so a
 * caller can swap between the two without changing how the result is used.
 *
 * `alias` is the orders table's alias in the calling query.
 */
async function teamScopeSql(teamLeadUserId, alias = 'o', groupKey = null) {
  // Oct 6, 2026: a My Team tab narrows the team to one group (see teamGroups); an unknown
  // key matches nothing rather than falling back to the whole team.
  if (groupKey) {
    const group = (await teamGroups(teamLeadUserId)).find((g) => g.key === groupKey);
    if (!group || !group.ids.length) return { sql: '1 = 0', params: [] };
    return { sql: `${alias}.medrep_id IN (${group.ids.map(() => '?').join(', ')})`, params: group.ids };
  }
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
  teamGroups,
  teamScopeSql,
  canAccessOrder
};
