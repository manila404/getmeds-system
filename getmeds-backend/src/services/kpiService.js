'use strict';

/**
 * Sales KPIs per month — the ONE calculation behind both the hand-run CSV export
 * (scripts/kpi-export-month.js) and the in-app KPI page (/api/kpi). Oct 5, 2026.
 *
 * Moved here from the script unchanged, so the file and the page always agree. The rules
 * Aaron agreed (booked = the Finance sales-summary rule, credit to the order owner, roll-ups
 * are the sum of the people, people with no territory placed by their order division) are
 * described in the script's header and in item 13.1.1 of the Aaron sheet.
 *
 * Read-only: every caller runs it inside a READ ONLY transaction with a time limit.
 */

const fs = require('fs');

const MANILA = '+08:00';
const NOT_TRACKED = 'Not tracked yet';

/** [fromUtc, toUtc) for a YYYY-MM month in Philippine time. */
function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must look like 2026-09');
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [new Date(`${month}-01T00:00:00${MANILA}`).toISOString(), new Date(`${next}-01T00:00:00${MANILA}`).toISOString()];
}
const prevMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/* ───────── CSV ───────── */
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  return rows.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/* ───────── targets file ───────── */
function readTargets(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, 'utf8'));
}
function targetsFor(rows, month) {
  const m = new Map();
  for (const r of rows) {
    if (r.month !== month || r.target_php === '') continue;
    const n = Number(String(r.target_php).replace(/[₱,\s]/g, ''));
    if (Number.isFinite(n) && n >= 0) m.set(String(r.email || '').toLowerCase(), n);
  }
  return m;
}
/** Copies FROM's rows to TO. Never overwrites a row that already exists for TO. */
function copyTargets(rows, from, to) {
  const have = new Set(rows.filter((r) => r.month === to).map((r) => String(r.email).toLowerCase()));
  const added = [];
  for (const r of rows.filter((x) => x.month === from && x.target_php !== '')) {
    if (!have.has(String(r.email).toLowerCase())) added.push({ ...r, month: to });
  }
  return { rows: [...rows, ...added], added: added.length, kept: have.size };
}

/* ───────── the export ───────── */
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : '');

/**
 * targetRows: rows of targets.csv (email, month, target_php) — the script's file mode.
 * Leave it out to read the kpi_targets table instead (the app, and the script once the
 * table exists).
 */
async function buildExport(client, month, targetRows) {
  const [fromUtc, toUtc] = monthRange(month);
  const { importedSql } = require('./orderOrigin');
  const notImported = `NOT (${importedSql('o')})`;

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  const titled = (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'sales_title'`)).length > 0;
  const users = await q(`SELECT id, name, email, role, is_active, team_lead_id${titled ? ', sales_title' : ''} FROM users`);
  const byId = new Map(users.map((u) => [u.id, u]));

  // structure: channels, managers (team leads / heads), territories, accounts' salespersons
  const channels = await q('SELECT id, name, head_name, head_user_id FROM sales_channels ORDER BY sort_order, id');
  const managers = await q('SELECT id, channel_id, name, user_id, acts_as_head FROM sales_managers');
  const terrs = await q('SELECT id, manager_id, zoho_salesperson, hq FROM sales_territories');
  const accts = await q('SELECT user_id, salesperson, is_primary FROM user_salespersons ORDER BY is_primary DESC, id');

  // BOOKED — one row per order, by its latest FINANCE_VERIFIED event in the month
  const booked = await q(
    `SELECT id, medrep_id, raised_by_id, total_amount, status, division FROM (
        SELECT DISTINCT ON (o.id) o.id, o.medrep_id, o.raised_by_id, o.total_amount, o.status, o.division
          FROM order_events fe JOIN orders o ON o.id = fe.order_id
         WHERE fe.event_type = 'FINANCE_VERIFIED' AND ${notImported}
           AND o.status NOT IN ('cancelled', 'deleted')
           AND fe.created_at >= $1 AND fe.created_at < $2
         ORDER BY o.id, fe.created_at DESC) b`,
    [fromUtc, toUtc]
  );
  // NEW CUSTOMERS (Oct 8, 2026, Aaron): a booked order that is its customer's FIRST-EVER order.
  // Any earlier order for the customer (Zoho history included; drafts, cancelled and deleted
  // not) means it is not new. Credited to that order's owner, in the month Finance confirmed it.
  // One index lookup per booked order (orders.customer_id is indexed).
  const firstOrders = booked.length ? await q(
    `SELECT o.id, o.medrep_id FROM orders o
      WHERE o.id = ANY($1) AND o.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders e
           WHERE e.customer_id = o.customer_id AND e.id <> o.id
             AND e.status NOT IN ('draft', 'cancelled', 'deleted')
             AND (e.created_at < o.created_at OR (e.created_at = o.created_at AND e.id < o.id)))`,
    [booked.map((b) => b.id)]
  ) : [];
  const raised = await q(
    `SELECT o.id, o.medrep_id, o.division FROM orders o
      WHERE o.created_at >= $1 AND o.created_at < $2 AND ${notImported}
        AND o.status NOT IN ('draft', 'cancelled', 'deleted')`,
    [fromUtc, toUtc]
  );
  const held = await q(
    `SELECT DISTINCT o.id, o.medrep_id FROM order_events e JOIN orders o ON o.id = e.order_id
      WHERE e.new_status = 'on_hold' AND e.old_status IS DISTINCT FROM 'on_hold'
        AND e.created_at >= $1 AND e.created_at < $2 AND ${notImported} AND o.status <> 'deleted'`,
    [fromUtc, toUtc]
  );

  // ── who sits where ──
  const terrBySp = new Map(terrs.map((t) => [String(t.zoho_salesperson || '').toLowerCase(), t]));
  const mgrById = new Map(managers.map((m) => [m.id, m]));
  const chById = new Map(channels.map((c) => [c.id, c]));
  const place = new Map(); // user_id -> { channelIds:Set, primaryChannel, hqs:Set }
  for (const a of accts) {
    const t = terrBySp.get(String(a.salesperson || '').toLowerCase());
    if (!t) continue;
    const m = mgrById.get(t.manager_id);
    const p = place.get(a.user_id) || { channelIds: [], hqs: [] };
    if (m && !p.channelIds.includes(m.channel_id)) p.channelIds.push(m.channel_id);
    if (t.hq) p.hqs.push(String(t.hq).toUpperCase());
    place.set(a.user_id, p);
  }
  const repType = (uid) => {
    const p = place.get(uid);
    if (!p || !p.hqs.length) return 'Unplaced';
    return p.hqs.includes('ON SITE') ? 'On-site' : 'Field';
  };
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^rx/, '');
  const chByNorm = new Map(channels.map((c) => [norm(c.name), c]));
  const chForDivision = (div) => {
    const d = norm(div);
    if (!d) return null;
    if (chByNorm.has(d)) return chByNorm.get(d);
    if (d === 'hos' && chByNorm.has('hosp')) return chByNorm.get('hosp');
    if ((d.startsWith('telesales') || d.startsWith('mdtelesales')) && chByNorm.has('telesales')) return chByNorm.get('telesales');
    return null;
  };
  const territoryChannel = (uid) => { const p = place.get(uid); return p && p.channelIds.length ? chById.get(p.channelIds[0]) : null; };
  // the division carrying most of a person's booked pesos (else most of their orders this month)
  const divAmt = new Map(), divCnt = new Map();
  const bump = (m, uid, div, n) => { if (!uid || !div) return; const d = m.get(uid) || new Map(); d.set(div, (d.get(div) || 0) + n); m.set(uid, d); };
  for (const o of booked) bump(divAmt, o.medrep_id, o.division, Number(o.total_amount) || 0);
  for (const o of raised) bump(divCnt, o.medrep_id, o.division, 1);
  const topDivision = (uid) => {
    const m = divAmt.get(uid) && divAmt.get(uid).size ? divAmt.get(uid) : divCnt.get(uid);
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const channelOf = (uid) => territoryChannel(uid) || chForDivision(topDivision(uid));
  const channelSource = (uid) => (territoryChannel(uid) ? 'territory' : chForDivision(topDivision(uid)) ? 'order division (fallback)' : 'none');

  // ── per-owner tallies ──
  const T = new Map();
  const tally = (id) => { if (!T.has(id)) T.set(id, { booked: 0, bookedN: 0, completed: 0, byOthersN: 0, byOthers: 0, raisedForOthersN: 0, raisedForOthers: 0, orders: 0, held: 0, newCustomers: 0 }); return T.get(id); };
  const routing = new Map();
  for (const o of booked) {
    const amt = Number(o.total_amount) || 0;
    const t = tally(o.medrep_id);
    t.booked += amt; t.bookedN += 1;
    if (o.status === 'completed') t.completed += amt;
    if (o.raised_by_id && o.raised_by_id !== o.medrep_id) {
      t.byOthersN += 1; t.byOthers += amt;
      const r = tally(o.raised_by_id); r.raisedForOthersN += 1; r.raisedForOthers += amt;
      const k = `${o.medrep_id}|${o.raised_by_id}`;
      const e = routing.get(k) || { owner: o.medrep_id, raiser: o.raised_by_id, n: 0, amt: 0 };
      e.n += 1; e.amt += amt; routing.set(k, e);
    }
  }
  for (const o of raised) tally(o.medrep_id).orders += 1;
  for (const o of held) tally(o.medrep_id).held += 1;
  for (const o of firstOrders) if (o.medrep_id) tally(o.medrep_id).newCustomers += 1;

  const fileMode = Array.isArray(targetRows);
  const targets = fileMode ? targetsFor(targetRows, month) : await dbTargets(q, month);
  const targetOf = (u) => (fileMode ? targets.get(String(u.email).toLowerCase()) : targets.get(u.id));
  const salespeople = users.filter((u) => ['medrep', 'team_lead'].includes(u.role) && (u.is_active || T.has(u.id)));
  const personIds = new Set(salespeople.map((u) => u.id));
  const ownerOnly = [...T.keys()].filter((id) => id && !personIds.has(id)).map((id) => byId.get(id)).filter(Boolean);
  const peopleList = [...salespeople, ...ownerOnly];

  const people = peopleList.map((u) => {
    const t = T.get(u.id) || tally(u.id);
    const lead = u.team_lead_id ? byId.get(u.team_lead_id) : null;
    const ch = channelOf(u.id);
    const target = targetOf(u);
    return {
      user_id: u.id, person: u.name, email: u.email, role: u.role, active: u.is_active ? 'yes' : 'no',
      rep_type: repType(u.id), team_lead: lead ? lead.name : '(none)', channel: ch ? ch.name : '(unplaced)', channel_source: channelSource(u.id),
      order_divisions: [...((divAmt.get(u.id) || divCnt.get(u.id)) || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d).join(' / '),
      head: ch ? ch.head_name : '(none)',
      target_php: target === undefined ? '' : target,
      booked_php: peso(t.booked), booked_orders: t.bookedN, pct_of_target: target ? pct(t.booked, target) : '',
      delivered_php: peso(t.completed), orders: t.orders, orders_held: t.held,
      booked_raised_by_others_php: peso(t.byOthers), booked_raised_by_others_orders: t.byOthersN,
      raised_for_others_info_php: peso(t.raisedForOthers),
      new_customers: t.newCustomers, followups_on_time: NOT_TRACKED
    };
  });

  const sumRows = (rows, labelCols) => {
    const g = new Map();
    for (const r of rows) {
      const key = labelCols.map((c) => r[c]).join('|');
      if (!g.has(key)) g.set(key, { ...Object.fromEntries(labelCols.map((c) => [c, r[c]])), people: 0, target_php: 0, targets_missing: 0, booked_php: 0, booked_orders: 0, delivered_php: 0, orders: 0, orders_held: 0, booked_raised_by_others_php: 0, raised_for_others_info_php: 0, new_customers: 0 });
      const a = g.get(key);
      a.people += 1; a.booked_php += r.booked_php; a.booked_orders += r.booked_orders; a.delivered_php += r.delivered_php;
      a.new_customers += Number(r.new_customers) || 0;
      a.orders += r.orders; a.orders_held += r.orders_held; a.booked_raised_by_others_php += r.booked_raised_by_others_php; a.raised_for_others_info_php += r.raised_for_others_info_php;
      if (r.target_php === '') a.targets_missing += 1; else a.target_php += r.target_php;
    }
    return [...g.values()].map((a) => ({
      ...a, target_php: peso(a.target_php), booked_php: peso(a.booked_php), delivered_php: peso(a.delivered_php),
      booked_raised_by_others_php: peso(a.booked_raised_by_others_php), raised_for_others_info_php: peso(a.raised_for_others_info_php),
      pct_of_target: a.target_php ? pct(a.booked_php, a.target_php) : '', followups_on_time: NOT_TRACKED
    }));
  };
  // everyone with NO territory in the sales structure (placed by order division, or still unplaced)
  const unplaced = people.filter((p) => p.channel_source !== 'territory')
    .map((p) => ({
      person: p.person, email: p.email, role: p.role, active: p.active, team_lead: p.team_lead,
      booked_php: p.booked_php, booked_orders: p.booked_orders, orders: p.orders,
      order_divisions: p.order_divisions, placed_in_export_as: p.channel, how_placed: p.channel_source,
      suggested_territory_to_map: ''
    })).sort((a, b) => b.booked_php - a.booked_php || String(a.person).localeCompare(String(b.person)));
  // Oct 8, 2026: a team lead's row is the lead PLUS everyone below them in the Team Lead chain
  // (Manager > Team Leader > Leader > MedRep), the same rule as My Team KPI, so Honey's row
  // includes her Leaders' MedReps. Rows therefore overlap (Honey's contains Sheila's) and are
  // not meant to be added up; '(none)' holds the people who are on nobody's team.
  const below = new Map();
  for (const u of users) if (u.team_lead_id) { if (!below.has(u.team_lead_id)) below.set(u.team_lead_id, []); below.get(u.team_lead_id).push(u.id); }
  const teamOf = (id) => {
    const seen = new Set();
    let level = [...(below.get(id) || [])];
    for (let d = 0; d < 6 && level.length; d++) {
      const next = [];
      for (const x of level) { if (x === id || seen.has(x)) continue; seen.add(x); next.push(...(below.get(x) || [])); }
      level = next;
    }
    return seen;
  };
  const chainOf = (u) => { // names from the top of the tree down to u, for ordering and indenting
    const names = [u.name]; let cur = u, guard = 0;
    while (cur.team_lead_id && guard++ < 6) { cur = byId.get(cur.team_lead_id); if (!cur || names.includes(cur.name)) break; names.unshift(cur.name); }
    return names;
  };
  const peopleById = new Map(people.map((p) => [p.user_id, p]));
  const inSomeTeam = new Set();
  const teams = users
    .filter((u) => u.role === 'team_lead' && below.has(u.id) && (u.is_active || T.has(u.id)))
    .map((lead) => {
      const ids = [lead.id, ...teamOf(lead.id)];
      ids.forEach((id) => inSomeTeam.add(id));
      const rows = ids.map((id) => peopleById.get(id)).filter(Boolean).map((p) => ({ ...p, team_lead: lead.name }));
      const [sum] = sumRows(rows.length ? rows : [{ team_lead: lead.name, booked_php: 0, booked_orders: 0, delivered_php: 0, orders: 0, orders_held: 0, booked_raised_by_others_php: 0, raised_for_others_info_php: 0, target_php: '' }], ['team_lead']);
      const chain = chainOf(lead);
      return { ...sum, people: rows.length, title: lead.sales_title || '', reports_to: chain.length > 1 ? chain[chain.length - 2] : '', level: chain.length - 1, _order: chain.join(' > ') };
    })
    .sort((a, b) => a._order.localeCompare(b._order))
    .map(({ _order, ...t }) => t);
  const loners = people.filter((p) => !inSomeTeam.has(p.user_id));
  if (loners.length) teams.push({ ...sumRows(loners.map((p) => ({ ...p, team_lead: '(none)' })), ['team_lead'])[0], title: '', reports_to: '', level: 0 });
  const channelRows = sumRows(people, ['channel']);
  const heads = sumRows(people, ['head']);

  const routingRows = [...routing.values()].map((r) => ({
    owner_credited: byId.get(r.owner)?.name || r.owner, owner_rep_type: repType(r.owner),
    raised_by: byId.get(r.raiser)?.name || r.raiser, raiser_rep_type: repType(r.raiser),
    booked_orders: r.n, booked_php: peso(r.amt)
  })).sort((a, b) => b.booked_php - a.booked_php);

  // ── checks ──
  const totalBooked = peso(booked.reduce((s, o) => s + (Number(o.total_amount) || 0), 0));
  const exportedBooked = peso(people.reduce((s, p) => s + p.booked_php, 0));
  const noOwner = booked.filter((o) => !o.medrep_id).length;
  const multi = peopleList.filter((u) => (place.get(u.id)?.channelIds.length || 0) > 1).map((u) => u.name);
  const missingTargets = people.filter((p) => p.active === 'yes' && p.target_php === '').length;
  const partial = Date.now() < Date.parse(toUtc);
  const checks = [
    { check: 'Month (Philippine time)', value: month, note: `${fromUtc} to ${toUtc} (UTC)${partial ? ' — month still running, figures so far' : ''}` },
    { check: 'Booked total by the Finance rule (all orders)', value: totalBooked, note: 'Compare with Finance > Sales Summary "Forecast" for the same month' },
    { check: 'Booked total in this export (sum of people)', value: exportedBooked, note: exportedBooked === totalBooked ? 'OK — matches' : 'MISMATCH — orders not tied to a listed person' },
    { check: 'Booked orders (count)', value: booked.length, note: '' },
    { check: 'Booked orders with no owner', value: noOwner, note: noOwner ? 'Not credited to anyone' : 'OK' },
    { check: 'Orders raised by someone other than the owner (booked)', value: booked.filter((o) => o.raised_by_id && o.raised_by_id !== o.medrep_id).length, note: 'Credited to the owner; see 05-routing.csv' },
    { check: 'People counted under more than one channel', value: multi.length, note: multi.length ? `Counted once, under their primary channel: ${multi.join('; ')}` : 'OK' },
    { check: 'People with no territory in the sales structure', value: unplaced.length, note: `placed by order division: ${unplaced.filter((p) => p.how_placed !== 'none').length}; still unplaced: ${unplaced.filter((p) => p.how_placed === 'none').length}. Listed in 07-unplaced-people.csv` },
    { check: 'Booked pesos of people with no territory', value: peso(unplaced.reduce((a, p) => a + p.booked_php, 0)), note: 'Included in channel and head totals through the order-division fallback' },
    { check: 'Booked pesos still in no channel', value: peso(people.filter((p) => p.channel === '(unplaced)').reduce((a, p) => a + p.booked_php, 0)), note: 'Their orders carry no division that matches a channel' },
    { check: 'Active people with no target for this month', value: missingTargets, note: missingTargets ? (fileMode ? 'Fill targets.csv, or use --copy-targets' : 'Set them in KPI > Set targets, or copy last month') : 'OK' },
    { check: 'New customers', value: firstOrders.length, note: "Booked orders that are their customer's first-ever order (Zoho history counts as earlier), credited to the order's owner" },
    { check: 'Follow-ups on time', value: NOT_TRACKED, note: 'The live system has no follow-up dates yet' }
  ];
  return { month, fromUtc, toUtc, partial, people, teams, heads, channels: channelRows, routing: routingRows, unplaced, checks, totalBooked, exportedBooked };
}

const COLS = {
  people: ['person', 'email', 'role', 'active', 'rep_type', 'team_lead', 'channel', 'channel_source', 'order_divisions', 'head', 'target_php', 'booked_php', 'pct_of_target', 'booked_orders', 'delivered_php', 'orders', 'orders_held', 'booked_raised_by_others_php', 'booked_raised_by_others_orders', 'raised_for_others_info_php', 'new_customers', 'followups_on_time'],
  group: (label) => [label, 'people', 'target_php', 'targets_missing', 'booked_php', 'pct_of_target', 'booked_orders', 'delivered_php', 'orders', 'orders_held', 'booked_raised_by_others_php', 'raised_for_others_info_php', 'new_customers', 'followups_on_time'],
  // Oct 8, 2026: team rows cover the whole chain below the lead, so they carry where they sit
  teams: ['team_lead', 'title', 'reports_to', 'level', 'people', 'target_php', 'targets_missing', 'booked_php', 'pct_of_target', 'booked_orders', 'delivered_php', 'orders', 'orders_held', 'booked_raised_by_others_php', 'raised_for_others_info_php', 'new_customers', 'followups_on_time'],
  routing: ['owner_credited', 'owner_rep_type', 'raised_by', 'raiser_rep_type', 'booked_orders', 'booked_php'],
  checks: ['check', 'value', 'note'],
  unplaced: ['person', 'email', 'role', 'active', 'team_lead', 'booked_php', 'booked_orders', 'orders', 'order_divisions', 'placed_in_export_as', 'how_placed', 'suggested_territory_to_map']
};


/** The kpi_targets rows for a month, keyed by user id. */
async function dbTargets(q, month) {
  const rows = await q('SELECT user_id, target_php FROM kpi_targets WHERE month = $1', [month]);
  return new Map(rows.map((r) => [r.user_id, Number(r.target_php)]));
}

/** The current month in Philippine time, as YYYY-MM. */
function currentMonth(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

module.exports = { MANILA, NOT_TRACKED, monthRange, prevMonth, toCsv, parseCsv, readTargets, targetsFor, copyTargets, buildExport, currentMonth, COLS };
