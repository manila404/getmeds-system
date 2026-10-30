'use strict';

/**
 * Move / change role for someone in the Sales department. Oct 30, 2026 (Aaron).
 *
 * Changing a salesperson's role used to change only users.role. Everything tied to
 * them stayed where it was: the people reporting to them, their Team Lead row in the
 * Team Structure, their Zoho names, the orders they still had to finish. This is the
 * one place that changes all of it together, in three steps:
 *
 *   describe(id)        what they hold now, and the choices for the form
 *   plan(id, choice)    every switch the choice makes (ON / OFF / MOVE / KEEP), plus
 *                       anything that blocks it; nothing is written
 *   apply(id, choice)   the same plan, written in one transaction, then the people
 *                       affected are told
 *
 * Sales only: MedRep and Team Lead, to MedRep or Team Lead. Past work never moves:
 * completed, shipped and Finance-stage orders and past KPI stay with the person. Only
 * the orders they still have to act on (draft / sent back, waiting for approval, on
 * hold, exception) can move, and Zoho is never touched.
 *
 * The choice:
 *   role                 'medrep' | 'team_lead'
 *   primary_salesperson  new main Zoho name (a territory in the Team Structure), or null to keep
 *   names                { "<Zoho name they hold>": 'keep' | 'vacant' | 'hand' }  (default keep)
 *   hand_to              successor's user id: receives names marked 'hand', and the orders when orders = 'hand'
 *   team_lead_id         who they report to (null = nobody); omitted = unchanged
 *   people_to            where the people reporting to them go (a Team Lead id); omitted = they stay
 *   lead_channel_id      becoming a Team Lead: add their Team Lead row in this channel
 *   orders               'keep' | 'hand'   (default keep)
 */

const db = require('../db/database');
const salespersonService = require('./salespersonService');
const { salespersonPrefix } = require('./salespersonDivision');
const { notify } = require('./notificationService');

const SALES_ROLES = ['medrep', 'team_lead'];
const TO_ACT_ON = ['draft', 'pending_management_approval', 'on_hold', 'exception'];
// Mirrors DIVISIONS in controllers/orders.controller.js (MT added Oct 30, 2026).
const DIVISIONS = ['B&B', 'B2B', 'B2C', 'BID', 'CLIDP', 'HOS', 'MSA', 'STC', 'TeleSales Anesthesia', 'URO', 'TeleSales', 'MD Telesales', 'PS', 'MT'];
const ROLE_LABEL = { medrep: 'MedRep', team_lead: 'Team Lead' };
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

class MoveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function territoryByName() {
  const rows = await db.prepare(
    `SELECT t.id, t.zoho_salesperson, t.zoho_alias, t.is_vacant, m.channel_id, c.name AS channel
       FROM sales_territories t JOIN sales_managers m ON m.id = t.manager_id JOIN sales_channels c ON c.id = m.channel_id`
  ).all();
  const map = new Map();
  for (const t of rows) {
    map.set(norm(t.zoho_salesperson), t);
    if (t.zoho_alias) map.set(norm(t.zoho_alias), t);
  }
  return { rows, map };
}

async function loadPerson(id) {
  const u = await db.prepare(
    `SELECT u.id, u.name, u.role, u.is_active, u.division, u.sales_title, u.team_lead_id, tl.name AS team_lead_name
       FROM users u LEFT JOIN users tl ON tl.id = u.team_lead_id WHERE u.id = ?`
  ).get(id);
  if (!u) throw new MoveError(404, 'User not found.');
  if (!SALES_ROLES.includes(u.role)) throw new MoveError(409, `${u.name} is not in the Sales department (role: ${u.role}).`);
  if (!(u.is_active === 1 || u.is_active === true)) throw new MoveError(409, `${u.name} is deactivated.`);
  return u;
}

/** What the person holds now, and the lists the form picks from. */
async function describe(id) {
  const u = await loadPerson(id);
  const { rows: terrs, map } = await territoryByName();
  const names = await db.prepare('SELECT salesperson, is_primary FROM user_salespersons WHERE user_id = ? ORDER BY is_primary DESC, id').all(id);
  const people = await db.prepare('SELECT id, name, role FROM users WHERE team_lead_id = ? AND is_active = 1 ORDER BY name').all(id);
  const leadRows = await db.prepare(
    'SELECT m.id, m.name, m.channel_id, c.name AS channel FROM sales_managers m JOIN sales_channels c ON c.id = m.channel_id WHERE m.user_id = ?'
  ).all(id);
  const headOf = await db.prepare('SELECT id, name FROM sales_channels WHERE head_user_id = ?').all(id);
  const orders = await db.prepare(
    `SELECT id, getmeds_order_id, status, total_amount, salesperson FROM orders
      WHERE medrep_id = ? AND status IN (${TO_ACT_ON.map(() => '?').join(', ')}) ORDER BY created_at DESC`
  ).all(id, ...TO_ACT_ON);

  const holders = await db.prepare(
    `SELECT us.salesperson, u.name FROM user_salespersons us JOIN users u ON u.id = us.user_id WHERE u.is_active = 1`
  ).all();
  const heldBy = new Map();
  for (const h of holders) {
    const t = map.get(norm(h.salesperson));
    if (!t) continue;
    if (!heldBy.has(t.id)) heldBy.set(t.id, []);
    heldBy.get(t.id).push(h.name);
  }
  const channels = await db.prepare('SELECT id, name FROM sales_channels ORDER BY sort_order, id').all();
  const sales = await db.prepare(
    `SELECT id, name, role FROM users WHERE is_active = 1 AND role IN ('medrep', 'team_lead') AND id <> ? ORDER BY name`
  ).all(id);

  return {
    person: {
      id: u.id, name: u.name, role: u.role, role_label: ROLE_LABEL[u.role], division: u.division, sales_title: u.sales_title,
      team_lead: u.team_lead_id ? { id: u.team_lead_id, name: u.team_lead_name } : null
    },
    names: names.map((n) => {
      const t = map.get(norm(n.salesperson));
      return { name: n.salesperson, primary: Boolean(n.is_primary), channel: t ? t.channel : null, channel_id: t ? t.channel_id : null };
    }),
    people,
    lead_rows: leadRows,
    head_of: headOf,
    orders_to_act_on: orders,
    choices: {
      channels: channels.map((c) => ({
        id: c.id, name: c.name,
        territories: terrs.filter((t) => t.channel_id === c.id).map((t) => ({
          name: t.zoho_salesperson, held_by: (heldBy.get(t.id) || []).filter((n) => n !== u.name), vacant: Boolean(t.is_vacant)
        }))
      })),
      team_leads: sales.filter((s) => s.role === 'team_lead'),
      sales_people: sales
    }
  };
}

/** Every switch the choice makes, and what blocks it. Writes nothing. */
async function plan(id, choice = {}) {
  const d = await describe(id);
  const u = d.person;
  const errors = [];
  const switches = [];
  const add = (action, what, detail = '') => switches.push({ action, what, detail });
  const role = choice.role || u.role;
  if (!SALES_ROLES.includes(role)) errors.push('The new role must be MedRep or Team Lead.');
  const toLead = role === 'team_lead';
  const leaving = u.role === 'team_lead' && !toLead;
  const nameOf = (uid) => (d.choices.sales_people.find((s) => s.id === uid) || {}).name;

  // Successor
  const handTo = choice.hand_to ? Number(choice.hand_to) : null;
  if (handTo && !nameOf(handTo)) errors.push('The person to hand over to must be an active MedRep or Team Lead.');

  // Role and title
  if (role !== u.role) add('SWITCH', 'Role', `${ROLE_LABEL[u.role]} → ${ROLE_LABEL[role]}`);
  else add('KEEP', 'Role', ROLE_LABEL[role]);
  const title = toLead ? (u.sales_title || 'Team Leader') : null;
  if ((title || null) !== (u.sales_title || null)) add(title ? 'ON' : 'OFF', 'Title', title || `"${u.sales_title}" cleared`);

  // Head of a channel: changed in Team Structure, not here
  if (leaving && d.head_of.length) {
    errors.push(`${u.name} is the Head of ${d.head_of.map((c) => c.name).join(', ')}. Change the Head in Team Structure first.`);
  }

  // Reports to
  let teamLeadId = u.team_lead ? u.team_lead.id : null;
  if (choice.team_lead_id !== undefined) {
    teamLeadId = choice.team_lead_id === null || choice.team_lead_id === '' ? null : Number(choice.team_lead_id);
  }
  const team = new Set(await require('./teamScopeService').teamMedrepIds(id));
  if (teamLeadId !== null) {
    const lead = d.choices.team_leads.find((t) => t.id === teamLeadId);
    if (!lead) errors.push('They must report to an active Team Lead.');
    else if (team.has(teamLeadId)) errors.push(`${lead.name} is in ${u.name}'s own team, so this would make a loop.`);
  }
  if (teamLeadId !== (u.team_lead ? u.team_lead.id : null)) {
    add('MOVE', 'Reports to', `${u.team_lead ? u.team_lead.name : 'nobody'} → ${teamLeadId ? nameOf(teamLeadId) || '?' : 'nobody'}`);
  } else add('KEEP', 'Reports to', u.team_lead ? u.team_lead.name : 'nobody');

  // The people under them
  let peopleTo;
  if (d.people.length) {
    if (choice.people_to !== undefined && choice.people_to !== null && choice.people_to !== '') {
      peopleTo = Number(choice.people_to);
      const lead = d.choices.team_leads.find((t) => t.id === peopleTo);
      if (!lead) errors.push('Their people must move to an active Team Lead.');
      else if (team.has(peopleTo)) errors.push(`${lead.name} is in ${u.name}'s own team; pick a Team Lead outside it.`);
      else add('MOVE', `${d.people.length} people report to`, `${u.name} → ${lead.name}: ${d.people.map((p) => p.name).join(', ')}`);
    } else if (leaving) {
      errors.push(`${d.people.length} people report to ${u.name}. Choose the Team Lead they move to.`);
    } else add('KEEP', `${d.people.length} people report to them`, d.people.map((p) => p.name).join(', '));
  }

  // Team Structure rows
  if (leaving) for (const r of d.lead_rows) add('OFF', `Team Lead row "${r.name}" in ${r.channel}`, 'Unlinked from their account; its territories stay. Link a new Team Lead in Team Structure.');
  else for (const r of d.lead_rows) add('KEEP', `Team Lead row "${r.name}" in ${r.channel}`);
  if (toLead && choice.lead_channel_id) {
    const ch = d.choices.channels.find((c) => c.id === Number(choice.lead_channel_id));
    if (!ch) errors.push('Pick a valid channel for their Team Lead row.');
    else if (!d.lead_rows.some((r) => r.channel_id === ch.id)) add('ON', `Team Lead row in ${ch.name}`, `"${u.name.split(' ')[0]}", linked to their account`);
  }

  // Zoho names
  const newPrimary = choice.primary_salesperson ? String(choice.primary_salesperson).trim() : null;
  const finalNames = [];
  const handed = [];
  const vacated = [];
  let primaryName = (d.names.find((n) => n.primary) || d.names[0] || {}).name || null;
  if (newPrimary) {
    const all = d.choices.channels.flatMap((c) => c.territories.map((t) => ({ ...t, channel: c.name })));
    const t = all.find((x) => norm(x.name) === norm(newPrimary));
    if (!t) errors.push(`"${newPrimary}" is not a territory in the Team Structure.`);
    else if (!d.names.some((n) => norm(n.name) === norm(newPrimary))) {
      add('ON', `Zoho name ${t.name}`, `${t.channel}, main name${t.held_by.length ? ` (also held by ${t.held_by.join(', ')})` : ''}`);
    } else if (norm(newPrimary) !== norm(primaryName)) add('SWITCH', 'Main Zoho name', `${primaryName} → ${t.name}`);
    if (t) { finalNames.push(t.name); primaryName = t.name; }
  }
  for (const n of d.names) {
    if (newPrimary && norm(n.name) === norm(newPrimary)) continue;
    const what = (choice.names || {})[n.name] || 'keep';
    if (what === 'hand') {
      if (!handTo) errors.push(`Pick who receives ${n.name}.`);
      else { handed.push(n.name); add('MOVE', `Zoho name ${n.name}`, `→ ${nameOf(handTo)}`); }
    } else if (what === 'vacant') { vacated.push(n.name); add('OFF', `Zoho name ${n.name}`, 'The territory is marked vacant'); }
    else { finalNames.push(n.name); add('KEEP', `Zoho name ${n.name}`, n.channel || ''); }
  }
  if (!finalNames.some((n) => norm(n) === norm(primaryName))) primaryName = finalNames[0] || null;
  if (role === 'medrep' && !finalNames.length) errors.push('A MedRep needs at least one Zoho name to raise orders.');

  // Division, from the main Zoho name
  let division = u.division;
  if (primaryName) {
    const prefix = norm(salespersonPrefix(primaryName));
    const match = DIVISIONS.find((x) => norm(x) === prefix);
    if (match && !norm(u.division).startsWith(prefix)) division = match;
  }
  if ((division || null) !== (u.division || null)) add('SWITCH', 'Division', `${u.division || 'none'} → ${division}`);

  // Orders still to act on
  const ordersWhat = choice.orders === 'hand' ? 'hand' : 'keep';
  if (d.orders_to_act_on.length) {
    if (ordersWhat === 'hand') {
      if (!handTo) errors.push('Pick who receives their orders.');
      else add('MOVE', `${d.orders_to_act_on.length} orders still to act on`, `→ ${nameOf(handTo)}: ${d.orders_to_act_on.map((o) => o.getmeds_order_id).join(', ')}`);
    } else add('KEEP', `${d.orders_to_act_on.length} orders still to act on`, d.orders_to_act_on.map((o) => o.getmeds_order_id).join(', '));
  }
  add('KEEP', 'Past orders and KPI', 'Completed, shipped and Finance-stage orders stay with them');

  return {
    person: u, switches, errors,
    _do: { role, title, teamLeadId, peopleTo, finalNames, primaryName, handed, vacated, handTo, division, ordersWhat, leaving, d,
      leadChannelId: toLead && choice.lead_channel_id ? Number(choice.lead_channel_id) : null }
  };
}

/** Writes the plan in one transaction, then tells the people affected. */
async function apply(id, choice, actor) {
  const p = await plan(id, choice);
  if (p.errors.length) throw new MoveError(400, p.errors.join(' '));
  const x = p._do;
  const u = x.d.person;
  const now = new Date().toISOString();

  await db.transaction(async () => {
    await db.prepare('UPDATE users SET role = ?, sales_title = ?, team_lead_id = ?, division = ?, updated_at = ? WHERE id = ?')
      .run(x.role, x.title, x.teamLeadId, x.division, now, id);
    if (x.peopleTo) {
      await db.prepare('UPDATE users SET team_lead_id = ?, updated_at = ? WHERE team_lead_id = ? AND is_active = 1').run(x.peopleTo, now, id);
    }
    if (x.leaving) await db.prepare('UPDATE sales_managers SET user_id = NULL, updated_at = ? WHERE user_id = ?').run(now, id);
    if (x.leadChannelId && !x.d.lead_rows.some((r) => r.channel_id === x.leadChannelId)) {
      const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sales_managers WHERE channel_id = ?').get(x.leadChannelId);
      await db.prepare('INSERT INTO sales_managers (channel_id, name, user_id, acts_as_head, sort_order, updated_by) VALUES (?, ?, ?, false, ?, ?)')
        .run(x.leadChannelId, u.name.split(' ')[0], id, Number(max.m) + 1, actor.id);
    }
    await salespersonService.setForUser(id, x.finalNames, { primary: x.primaryName, actorId: actor.id });
    if (x.handed.length) {
      const theirs = await db.prepare('SELECT salesperson, is_primary FROM user_salespersons WHERE user_id = ? ORDER BY is_primary DESC, id').all(x.handTo);
      const keepPrimary = (theirs.find((t) => t.is_primary) || theirs[0] || {}).salesperson || x.handed[0];
      await salespersonService.setForUser(x.handTo, [...theirs.map((t) => t.salesperson), ...x.handed], { primary: keepPrimary, actorId: actor.id });
    }
    for (const n of x.vacated) {
      await db.prepare(
        `UPDATE sales_territories SET is_vacant = true, updated_at = ?
          WHERE (LOWER(TRIM(zoho_salesperson)) = ? OR LOWER(TRIM(COALESCE(zoho_alias, ''))) = ?)
            AND NOT EXISTS (SELECT 1 FROM user_salespersons us JOIN users v ON v.id = us.user_id
                             WHERE v.is_active = 1 AND LOWER(TRIM(us.salesperson)) = ?)`
      ).run(now, norm(n), norm(n), norm(n));
    }
    if (x.ordersWhat === 'hand' && x.d.orders_to_act_on.length) {
      const ids = x.d.orders_to_act_on.map((o) => o.id);
      const toName = (x.d.choices.sales_people.find((s) => s.id === x.handTo) || {}).name;
      for (const oid of ids) {
        await db.prepare(
          `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, created_at)
           SELECT id, 'ORDER_REASSIGNED', status, status, ?, ?, ?, ? FROM orders WHERE id = ?`
        ).run(actor.id, actor.name, `Moved from ${u.name} to ${toName}: ${u.name} changed role or department.`, now, oid);
      }
      await db.prepare(`UPDATE orders SET medrep_id = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(x.handTo, now, ...ids);
    }
  })();

  const summary = p.switches.filter((s) => s.action !== 'KEEP').map((s) => `${s.what}${s.detail ? ` (${s.detail})` : ''}`).join('; ');
  console.log(`[SALES_MOVE] ${actor.name} (#${actor.id}) changed ${u.name} (#${id}): ${summary}`);
  const tell = [id, x.handTo, x.teamLeadId, x.peopleTo].filter((v, i, a) => v && v !== actor.id && a.indexOf(v) === i);
  if (tell.length) {
    await notify({
      orderId: null, recipientIds: tell, eventType: 'SALES_MOVE',
      message: `${u.name}: ${summary || 'no change'}. Changed by ${actor.name}.`
    });
  }
  return { switches: p.switches };
}

module.exports = { describe, plan, apply, MoveError, TO_ACT_ON };
